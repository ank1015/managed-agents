export type ContractErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "SESSION_NOT_INITIALIZED"
  | "INITIALIZATION_CONFLICT"
  | "INPUT_CONFLICT"
  | "OPERATION_NOT_FOUND"
  | "COMPLETION_CONFLICT";

/** Transport-neutral shape; HTTP status mapping belongs to the API. */
export interface ContractError {
  code: ContractErrorCode;
  message: string;
}

/** Expected boundary failure. Unexpected runtime errors should propagate unchanged. */
export class ContractException extends Error implements ContractError {
  readonly code: ContractErrorCode;

  constructor(code: ContractErrorCode, message: string) {
    super(message);
    this.name = "ContractException";
    this.code = code;
  }

  toJSON(): ContractError {
    return { code: this.code, message: this.message };
  }
}
