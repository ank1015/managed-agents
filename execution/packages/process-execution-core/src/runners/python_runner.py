"""IPython execution driver. Control frames never share user stdout/stderr."""
import asyncio
import contextvars
import signal
import base64
import json
import os
import queue
import socket
import sys
import threading
import traceback
from IPython.core.interactiveshell import InteractiveShell
from traitlets.config import Config

sock = socket.create_connection(("127.0.0.1", int(os.environ.pop("EXECUTION_REPL_PORT"))))
secret = os.environ.pop("EXECUTION_REPL_TOKEN")
lock = threading.Lock()
commands = queue.Queue()
helpers = {}
helper_lock = threading.Lock()
local = threading.local()
current = {"execution_id": None, "cell_id": None}
next_helper = 0
cell_context = contextvars.ContextVar("cell", default={"execution_id": None, "cell_id": None})

def send(message):
    with lock:
        sock.sendall((json.dumps(message, ensure_ascii=True) + "\n").encode())

send({"type": "hello", "token": secret})

def event(kind, **data):
    send({"type": "event", **cell_context.get(), "kind": kind, **data})

class Output:
    encoding = "utf-8"
    def write(self, text):
        if text:
            # Bound individual frames even for a giant print.
            for offset in range(0, len(text), 16000):
                event(self.kind, text=text[offset:offset + 16000])
        return len(text)
    def flush(self): pass
    def isatty(self): return False
    def __init__(self, kind): self.kind = kind
    def fileno(self): return 1 if self.kind == "stdout" else 2

sys.stdout = Output("stdout")
sys.stderr = Output("stderr")

class Runtime:
    async def call(self, operation, params):
        global next_helper
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        with helper_lock:
            next_helper += 1
            identifier = str(next_helper)
            helpers[identifier] = (loop, future)
        send({"type":"helper", "id":identifier, **cell_context.get(), "operation":operation, "params":params})
        return await future
    async def exec(self, command, completion="finished", timeout_ms=None, **options):
        result = await self.call("execution.exec", {"command":{"type":"shell","script":command,"login":False},"cwd":None,"tty":False,
            "completion":{"mode":completion, **({"timeout_ms":timeout_ms} if completion == "finished" else {"wait_ms":options.pop("wait_ms",10000)})}, **options})
        return result
    async def read(self, path, **options):
        return await self.call("filesystem.read", {"path":str(path), "cwd":None, **options})
    async def write(self, path, content):
        return await self.call("filesystem.write", {"path":str(path),"cwd":None,"content":{"type":"text","data":content},"create_parents":True,"precondition":None})
    async def apply_patch(self, text):
        return await self.call("filesystem.patch", {"cwd":None,"patch":{"format":"codex","text":text}})
    def emit_json(self, data): event("json", data=data)
    async def display_image(self, path):
        result = await self.read(path, mode="image")
        event("image", image=result["image"])

runtime = Runtime()
# Behave like an interactive interpreter for imports from the current cwd.
sys.path.insert(0, "")
config = Config()
config.HistoryManager.enabled = False
config.InteractiveShell.colors = "nocolor"
shell = InteractiveShell.instance(config=config)
shell.user_ns["runtime"] = runtime
shell.history_manager.enabled = False

def publish(data, metadata=None, **kwargs):
    if "image/png" in data:
        event("display", mime_type="image/png", data_base64=data["image/png"])
    elif "image/jpeg" in data:
        event("display", mime_type="image/jpeg", data_base64=data["image/jpeg"])
    elif "text/plain" in data:
        event("result", text=str(data["text/plain"])[:65536])
shell.display_pub.publish = publish
shell.displayhook.write_format_data = lambda data, md=None: publish(data, md)
shell.displayhook.write_output_prompt = lambda: None
shell.displayhook.finish_displayhook = lambda: None

def no_input(*args, **kwargs): raise RuntimeError("interactive input is disabled in cells; use an exec PTY")
shell.user_ns["input"] = no_input

def settle(future, result, error):
    if future.done(): return
    if error: future.set_exception(RuntimeError(error))
    else: future.set_result(result)

def reader():
    try:
        for line in sock.makefile("rb"):
            message = json.loads(line)
            if message["type"] == "helper_result":
                with helper_lock: waiter = helpers.pop(message["id"], None)
                if waiter:
                    loop, future = waiter
                    loop.call_soon_threadsafe(settle, future, message.get("result"), message.get("error"))
            else: commands.put(message)
    finally:
        os._exit(0)
threading.Thread(target=reader, daemon=True).start()

async def main():
    while True:
        message = await asyncio.to_thread(commands.get)
        if message["type"] != "execute": continue
        current["execution_id"] = message["execution_id"]
        failed = False
        for cell in message["cells"]:
            current["cell_id"] = cell["id"]
            if failed and message["stop_on_error"]:
                send({"type":"cell_done",**current,"status":"skipped"}); continue
            cell_context.set(dict(current))
            send({"type":"cell_started",**current})
            status = "succeeded"
            try:
                transformed = shell.transform_cell(cell["code"])
                result = await shell.run_cell_async(cell["code"], transformed_cell=transformed, store_history=False)
                error = result.error_before_exec or result.error_in_exec
                if error:
                    status = "failed"
                    event("error", name=type(error).__name__, message=str(error)[:65536])
            except BaseException as error:
                status = "failed"
                event("error", name=type(error).__name__, message=str(error)[:65536], traceback=traceback.format_exc()[-65536:])
            failed |= status != "succeeded"
            send({"type":"cell_done",**current,"status":status})
        send({"type":"execution_done", "execution_id":current["execution_id"],"status":"failed" if failed else "succeeded"})
        # Keep provenance of late background output; never relabel it as a new result.

def interrupt(signum, frame):
    raise KeyboardInterrupt("cell interrupted")
signal.signal(signal.SIGINT, interrupt)
asyncio.run(main())
