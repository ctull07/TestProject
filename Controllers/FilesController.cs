using Microsoft.AspNetCore.Mvc;
using TestProject.Models;
using TestProject.Services;

namespace TestProject.Controllers
{
    [ApiController]
    [Route("api/files")]
    public class FilesController : ControllerBase
    {

        private readonly IFileService _files;

        public FilesController(IFileService files)
        {
            _files = files;
        }

        /// <summary>
        /// GET /api/files?path=/Documents&amp;q=budget&amp;sort=size&amp;dir=desc
        /// With no q, lists the folder. With q, searches it and everything beneath it.
        /// </summary>
        [HttpGet]
        public DirectoryListing Get(
            [FromQuery] string? path,
            [FromQuery] string? q,
            [FromQuery] SortField sort = SortField.Name,
            [FromQuery] SortDirection dir = SortDirection.Asc)
        {
            return _files.List(path, q, sort, dir);
        }

        /// <summary>
        /// POST /api/files/upload?path=/Documents with one multipart "file" field.
        /// The client sends one request per file, which gives it per-file progress and per-file errors.
        /// </summary>
        [HttpPost("upload")]
        public async Task<IActionResult> Upload([FromQuery] string? path, IFormFile file, CancellationToken cancellationToken)
        {
            await using var content = file.OpenReadStream();
            var result = await _files.SaveUploadAsync(path, file.FileName, content, cancellationToken);
            return StatusCode(StatusCodes.Status201Created, result);
        }

        /// <summary>
        /// GET /api/files/download?path=/Documents/a.pdf is a plain link that can be copied or opened in a tab.
        /// A single file is sent as is. A folder, or several paths, come back as a ZIP.
        /// </summary>
        [HttpGet("download")]
        public IActionResult DownloadByLink([FromQuery(Name = "path")] string[]? paths) => Download(paths);

        /// <summary>
        /// POST /api/files/download with repeated "path" form fields. Many selected items would not fit in a URL,
        /// so the browser submits them as a form.
        /// </summary>
        [HttpPost("download")]
        public IActionResult DownloadByForm([FromForm(Name = "path")] string[]? paths) => Download(paths);

        private IActionResult Download(string[]? paths)
        {
            var download = _files.OpenDownload(paths ?? Array.Empty<string>());
            // The result disposes the stream when the response ends, which also deletes a temporary ZIP.
            return File(download.Content, download.ContentType, download.FileName, enableRangeProcessing: true);
        }
    }
}
