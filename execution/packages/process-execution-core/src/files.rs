use crate::{
    Error, ErrorCode, ProcessExecutionCore, Result,
    api::*,
    core::{Runtime, validate_cwd, value},
    native,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{io::Cursor, sync::Arc};

impl ProcessExecutionCore {
    pub(crate) async fn read_file(
        &self,
        runtime: Arc<Runtime>,
        args: ReadRequest,
    ) -> Result<Value> {
        if args.offset == Some(0)
            || args.limit == Some(0)
            || args.max_bytes == Some(0)
            || args.max_lines == Some(0)
            || args.image_max_dimension == Some(0)
        {
            return Err(Error::invalid("read bounds must be positive"));
        }
        let file = runtime
            .native
            .read_file(native::ReadFileRequest {
                path: args.path,
                cwd: Some(validate_cwd(args.cwd)?),
                max_bytes: Some(self.inner.config.max_file_bytes),
            })
            .await?;
        let metadata = json!({"path":file.path,"size_bytes":file.data.len(),"sha256":file.sha256,"modified_at":file.metadata.modified_at_ms,"is_symlink":file.metadata.is_symlink});
        let guessed = image::guess_format(&file.data).ok();
        if matches!(args.mode, ReadMode::Image)
            || matches!(args.mode, ReadMode::Auto) && guessed.is_some()
        {
            let limit = self.inner.config.max_image_pixels;
            let max_bytes = self.inner.config.max_file_bytes;
            let prepared = tokio::task::spawn_blocking(move || {
                prepare_image(file.data, args.image_max_dimension, limit, max_bytes)
            })
            .await
            .map_err(|e| Error::new(ErrorCode::Io, e.to_string()))??;
            return Ok(json!({"type":"image","file":metadata,"image":prepared}));
        }
        if matches!(args.mode, ReadMode::Bytes) {
            return Ok(
                json!({"type":"bytes","file":metadata,"data_base64":STANDARD.encode(file.data)}),
            );
        }
        let text = String::from_utf8_lossy(&file.data);
        let lines: Vec<_> = text.split('\n').collect();
        let start = args.offset.unwrap_or(1) - 1;
        if start >= lines.len() {
            return Err(Error::invalid(format!(
                "offset exceeds file's {} lines",
                lines.len()
            )));
        }
        let max_bytes = args
            .max_bytes
            .unwrap_or(51200)
            .min(self.inner.config.max_output_bytes);
        let max_lines = args.max_lines.unwrap_or(2000);
        let selected_end = start
            .saturating_add(args.limit.unwrap_or(usize::MAX))
            .min(lines.len());
        let mut output = String::new();
        let mut count = 0;
        let first_line_exceeds_limit = lines[start].len() > max_bytes;
        for line in &lines[start..selected_end] {
            let size = line.len() + usize::from(count > 0);
            if count >= max_lines || output.len().saturating_add(size) > max_bytes {
                break;
            }
            if count > 0 {
                output.push('\n');
            }
            output.push_str(line);
            count += 1;
        }
        let end = start + count;
        Ok(
            json!({"type":"text","file":metadata,"text":output,"total_lines":lines.len(),"first_line":start+1,
            "returned_lines":count,"next_offset":if end < lines.len() && count > 0 {Some(end+1)} else {None},
            "truncated":end<selected_end,"first_line_exceeds_limit":first_line_exceeds_limit}),
        )
    }
    pub(crate) async fn write_file(
        &self,
        runtime: Arc<Runtime>,
        id: &str,
        args: WriteRequest,
    ) -> Result<Value> {
        let bytes = match args.content {
            FileContent::Text(text) => text.into_bytes(),
            FileContent::Base64(data) => STANDARD
                .decode(data)
                .map_err(|_| Error::invalid("invalid base64"))?,
        };
        let result = runtime
            .native
            .write_file(native::WriteFileRequest {
                mutation_id: id.into(),
                path: args.path,
                cwd: Some(validate_cwd(args.cwd)?),
                data: bytes,
                create_parent_directories: args.create_parents,
                mode: args
                    .precondition
                    .map(native::WriteFileMode::Conditional)
                    .unwrap_or(native::WriteFileMode::Overwrite),
            })
            .await?;
        value(result)
    }
}
/// Validate allocation before decoding. The caller receives inline bytes so a
/// stateless adapter never needs a second native read to display the image.
pub(crate) fn prepare_image(
    bytes: Vec<u8>,
    dimension: Option<u32>,
    max_pixels: u64,
    max_bytes: usize,
) -> Result<Value> {
    if bytes.len() > max_bytes {
        return Err(Error::new(
            ErrorCode::ResourceLimit,
            "image source exceeds file byte limit",
        ));
    }
    let format =
        image::guess_format(&bytes).map_err(|_| Error::invalid("invalid or unsupported image"))?;
    let reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| Error::invalid(e.to_string()))?;
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(Error::new(
            ErrorCode::ResourceLimit,
            "image exceeds pixel limit",
        ));
    }
    let mut reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(max_pixels.saturating_mul(8));
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| Error::invalid(format!("invalid image: {e}")))?;
    let (data, mime, out_width, out_height) =
        if dimension.is_some() || format == image::ImageFormat::Bmp {
            let resized = if let Some(n) = dimension {
                image.thumbnail(n, n)
            } else {
                image
            };
            let mut output = Cursor::new(Vec::new());
            resized
                .write_to(&mut output, image::ImageFormat::Png)
                .map_err(|e| Error::invalid(e.to_string()))?;
            (
                output.into_inner(),
                "image/png",
                resized.width(),
                resized.height(),
            )
        } else {
            (bytes, format.to_mime_type(), width, height)
        };
    if data.len() > max_bytes {
        return Err(Error::new(
            ErrorCode::ResourceLimit,
            "prepared image exceeds output limit",
        ));
    }
    Ok(
        json!({"mime_type":mime,"data_base64":STANDARD.encode(data),"width":out_width,"height":out_height,"original_width":width,"original_height":height}),
    )
}
