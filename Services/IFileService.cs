using TestProject.Models;

namespace TestProject.Services {
    public interface IFileService {
        /// <summary>
        /// Lists a folder, or when <paramref name="query"/> is set, searches it and everything beneath it.
        /// Paths are virtual: "/" is the configured home directory.
        /// </summary>
        DirectoryListing List(string? path, string? query, SortField sort, SortDirection dir);

        /// <summary>
        /// Total size and counts of everything beneath a folder. The walk can be long on a big tree, so it
        /// stops when the token is cancelled, and a recent answer is reused until something changes.
        /// </summary>
        FolderSize GetFolderSize(string? path, CancellationToken cancellationToken);

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

        /// <summary>Permanently deletes files and folders (with their contents).</summary>
        OperationResult Delete(IReadOnlyList<string> paths);

        /// <summary>Moves items into a folder. Nothing is overwritten: a name clash fails that item only.</summary>
        OperationResult Move(IReadOnlyList<string> paths, string? destination);

        /// <summary>Copies items into a folder. A name clash gets a suffix, "a (1).txt", like an upload.</summary>
        OperationResult Copy(IReadOnlyList<string> paths, string? destination);
    }
}
