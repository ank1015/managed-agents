#![doc = include_str!("../README.md")]

//! Transport-independent execution with global resource ownership. Every accepted request owns its work
//! until a replayable result is recorded; dropping a caller never cancels it.
mod api;
mod buffer;
mod config;
mod core;
mod execution;
mod files;
mod receipts;
mod repl;

// Retained for backend regression tests. Tool adapters should use `execute`.
#[doc(hidden)]
pub mod native;

pub use api::*;
pub use config::*;
pub use core::ProcessExecutionCore;
pub use native::{
    Command, Error, ErrorCode, FilePrecondition, PatchChange, PatchChangeKind, PatchInput,
    PatchReceipt, PatchStatus, ReplacementFile, Result, Shell, ShellKind, TextEdit,
    WriteFileReceipt,
};
