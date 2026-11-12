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

        /// <summary>
        /// Stores an uploaded file in a folder. A name that is already taken gets a suffix, "a (1).txt",
        /// so an upload never overwrites anything.
        /// </summary>
        Task<UploadResult> SaveUploadAsync(string? folderPath, string fileName, Stream content, CancellationToken cancellationToken);

        /// <summary>
        /// One file is streamed as is. A folder, or several items, come back as a ZIP.
        /// The caller owns the returned stream and must dispose it.
        /// </summary>
        DownloadFile OpenDownload(IReadOnlyList<string> paths);
    }
}
