using TestProject.Models;

namespace TestProject.Services
{
    public interface IFileService
    {
        /// <summary>
        /// Lists a folder, or when <paramref name="query"/> is set, searches it and everything beneath it.
        /// Paths are virtual: "/" is the configured home directory.
        /// </summary>
        DirectoryListing List(string? path, string? query, SortField sort, SortDirection dir);
    }
}
