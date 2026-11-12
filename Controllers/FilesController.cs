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
    }
}
