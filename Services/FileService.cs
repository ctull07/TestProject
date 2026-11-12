using System.IO.Compression;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.Options;
using TestProject.Models;

namespace TestProject.Services
{
    public class FileService : IFileService
    {
        private const int SearchLimit = 10_000;
        private const string OutsideRootMessage = "Path escapes the configured home directory";
        private const int MaxDownloadItems = 500;
        private const int MaxNameAttempts = 1000;
        private const int BufferSize = 81920;

        private static readonly FileExtensionContentTypeProvider ContentTypes = new();

        // Device names such as CON or NUL are special on Windows, even with an extension.
        private static readonly Regex ReservedNames =
            new(@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        // Shared by listing, search and ZIP building. Skipping reparse points means a symlink or junction is
        // never followed, so nothing outside the home directory can be reached through one.
        private const FileAttributes Skipped = FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint;

        private static readonly EnumerationOptions SingleLevel = new()
        {
            IgnoreInaccessible = true,
            AttributesToSkip = Skipped
        };

        private static readonly EnumerationOptions Recursive = new()
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = Skipped
        };

        // Windows and macOS file systems are case-insensitive by default; Linux is not.
        private static readonly StringComparison PathComparison =
            OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;

        // Absolute path of the home directory, without a trailing separator.
        private readonly string _root;

        public FileService(IOptions<FileBrowserOptions> options, IWebHostEnvironment environment)
        {
            _root = Path.TrimEndingDirectorySeparator(
                Path.GetFullPath(options.Value.RootPath, environment.ContentRootPath));
            Directory.CreateDirectory(_root);
        }

        public DirectoryListing List(string? path, string? query, SortField sort, SortDirection dir)
        {
            var fullPath = ResolveDirectory(path);
            var needle = query?.Trim() ?? "";
            var searching = needle.Length > 0;

            // Lazy enumeration: the file system is read once, and attributes come back with each entry.
            IEnumerable<FileSystemInfo> infos =
                new DirectoryInfo(fullPath).EnumerateFileSystemInfos("*", searching ? Recursive : SingleLevel);
            if (searching)
            {
                infos = infos
                    .Where(i => i.Name.Contains(needle, StringComparison.OrdinalIgnoreCase))
                    .Take(SearchLimit + 1);   // one extra row tells us the results were cut off
            }

            var entries = infos.Select(ToEntry).ToList();
            var truncated = searching && entries.Count > SearchLimit;
            if (truncated)
            {
                entries.RemoveAt(entries.Count - 1);
            }

            SortEntries(entries, sort, dir);

            var folders = entries.Count(e => e.Type == EntryType.Folder);
            var bytes = entries.Sum(e => e.Size ?? 0);
            var virtualPath = ToVirtualPath(fullPath);
            var parent = virtualPath == "/" ? null : ToVirtualPath(Path.GetDirectoryName(fullPath)!);

            return new DirectoryListing(
                virtualPath, parent, needle, sort, dir,
                new ListingTotals(folders, entries.Count - folders, bytes),
                truncated, entries);
        }

        // ---- upload ------------------------------------------------------------------------------------------

        public async Task<UploadResult> SaveUploadAsync(
            string? folderPath, string fileName, Stream content, CancellationToken cancellationToken)
        {
            var folder = ResolveDirectory(folderPath);
            var (output, target) = CreateNewFile(folder, CleanFileName(fileName));
            try
            {
                await using (output)
                {
                    await content.CopyToAsync(output, cancellationToken);
                }
            }
            catch
            {
                File.Delete(target);   // a cancelled or failed upload must not leave a half-written file behind
                throw;
            }
            return new UploadResult(Path.GetFileName(target), ToVirtualPath(target), new FileInfo(target).Length);
        }

        /// <summary>
        /// Creates the file with FileMode.CreateNew, which fails if the name is taken. Checking File.Exists first
        /// would race with a second upload of the same name, so the file system makes the decision instead.
        /// </summary>
        private static (FileStream Output, string FullPath) CreateNewFile(string folder, string name)
        {
            for (var attempt = 0; attempt <= MaxNameAttempts; attempt++)
            {
                var target = Path.Combine(folder, attempt == 0 ? name : WithSuffix(name, attempt));
                if (Directory.Exists(target))
                {
                    continue;
                }
                try
                {
                    var stream = new FileStream(
                        target, FileMode.CreateNew, FileAccess.Write, FileShare.None, BufferSize, FileOptions.Asynchronous);
                    return (stream, target);
                }
                catch (IOException) when (File.Exists(target))
                {
                    // Taken, possibly a moment ago by another upload. Try the next name.
                }
            }
            throw new FileServiceException(409, "Could not find a free name for \"" + name + "\"");
        }

        /// <summary>Keeps only the final name segment and rejects anything the file system would treat specially.</summary>
        private static string CleanFileName(string? fileName)
        {
            // Browsers send just the name, but a hand-made request can include folders.
            var name = Path.GetFileName((fileName ?? "").Replace('\\', '/')).Trim();
            if (name.Length == 0 || name.Length > 255 || name == "." || name == ".." ||
                name.EndsWith('.') || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || ReservedNames.IsMatch(name))
            {
                throw new FileServiceException(400, "Invalid file name");
            }
            return name;
        }

        /// <summary>"report.pdf" becomes "report (1).pdf".</summary>
        private static string WithSuffix(string name, int number) =>
            Path.GetFileNameWithoutExtension(name) + " (" + number + ")" + Path.GetExtension(name);

        // ---- download ----------------------------------------------------------------------------------------

        public DownloadFile OpenDownload(IReadOnlyList<string> paths)
        {
            if (paths.Count == 0)
            {
                throw new FileServiceException(400, "Nothing to download");
            }
            if (paths.Count > MaxDownloadItems)
            {
                throw new FileServiceException(400, "Too many items. Download at most " + MaxDownloadItems + " at a time");
            }

            var targets = WithoutNested(
                paths.Select(ResolveExisting).Distinct(StringComparer.FromComparison(PathComparison)).ToList());

            if (targets.Count == 1 && File.Exists(targets[0]))
            {
                var name = Path.GetFileName(targets[0]);
                var stream = new FileStream(
                    targets[0], FileMode.Open, FileAccess.Read, FileShare.ReadWrite, BufferSize,
                    FileOptions.Asynchronous | FileOptions.SequentialScan);
                return new DownloadFile(stream, name, ContentTypeFor(name));
            }

            var zipName = (targets.Count == 1 ? DisplayName(targets[0]) : "download") + ".zip";
            return new DownloadFile(BuildArchive(targets), zipName, "application/zip");
        }

        private string ResolveExisting(string? virtualPath)
        {
            var fullPath = Resolve(virtualPath);
            if ((!File.Exists(fullPath) && !Directory.Exists(fullPath)) || ContainsLink(fullPath))
            {
                throw new FileServiceException(404, "Not found: " + virtualPath);
            }
            return fullPath;
        }

        /// <summary>If a folder and something inside it were both chosen, the folder already covers it.</summary>
        private static List<string> WithoutNested(List<string> fullPaths)
        {
            var folders = fullPaths.Where(Directory.Exists).ToList();
            return fullPaths
                .Where(p => !folders.Any(f => f != p && p.StartsWith(f + Path.DirectorySeparatorChar, PathComparison)))
                .ToList();
        }

        /// <summary>
        /// Builds the ZIP in a temporary file that deletes itself when closed. The response then has a known
        /// length and supports resume, and a failure part way through is a clean error instead of a corrupt
        /// download. The trade-off is that the first byte waits for the whole archive.
        /// </summary>
        private static FileStream BuildArchive(IReadOnlyList<string> fullPaths)
        {
            var temp = new FileStream(
                Path.GetTempFileName(), FileMode.Create, FileAccess.ReadWrite, FileShare.None, BufferSize, FileOptions.DeleteOnClose);
            try
            {
                using (var zip = new ZipArchive(temp, ZipArchiveMode.Create, leaveOpen: true))
                {
                    // Items picked from search results can share a name, and a ZIP cannot hold two entries with one name.
                    var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var fullPath in fullPaths)
                    {
                        var entryName = DisplayName(fullPath);
                        for (var n = 1; !usedNames.Add(entryName); n++)
                        {
                            entryName = WithSuffix(DisplayName(fullPath), n);
                        }

                        if (File.Exists(fullPath))
                        {
                            zip.CreateEntryFromFile(fullPath, entryName, CompressionLevel.Fastest);
                        }
                        else
                        {
                            AddFolder(zip, fullPath, entryName);
                        }
                    }
                }
                temp.Position = 0;
                return temp;
            }
            catch
            {
                temp.Dispose();
                throw;
            }
        }

        private static void AddFolder(ZipArchive zip, string folder, string entryName)
        {
            zip.CreateEntry(entryName + "/");   // keeps empty folders in the archive
            foreach (var info in new DirectoryInfo(folder).EnumerateFileSystemInfos("*", Recursive))
            {
                var name = entryName + "/" + Path.GetRelativePath(folder, info.FullName).Replace(Path.DirectorySeparatorChar, '/');
                if (info is DirectoryInfo)
                {
                    zip.CreateEntry(name + "/");
                }
                else
                {
                    zip.CreateEntryFromFile(info.FullName, name, CompressionLevel.Fastest);
                }
            }
        }

        private static string DisplayName(string fullPath)
        {
            var name = Path.GetFileName(fullPath);
            return name.Length > 0 ? name : "files";
        }

        private static string ContentTypeFor(string fileName) =>
            ContentTypes.TryGetContentType(fileName, out var type) ? type : "application/octet-stream";

        // ---- path safety -------------------------------------------------------------------------------------

        /// <summary>
        /// Maps a client-supplied virtual path onto the file system. This is the only place a request path
        /// becomes a real path, so every endpoint gets the same protection.
        /// </summary>
        private string Resolve(string? virtualPath)
        {
            var segments = Split(virtualPath);
            string fullPath;
            try
            {
                fullPath = Path.GetFullPath(Path.Combine(_root, Path.Combine(segments)));
            }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
            {
                throw new FileServiceException(400, "Path contains invalid characters");
            }

            // Defense in depth. ".." is already rejected, but a rooted segment such as "C:" on Windows would make
            // Path.Combine discard the root, so the final answer has to be checked against the root as well.
            if (!IsInsideRoot(fullPath))
            {
                throw new FileServiceException(400, OutsideRootMessage);
            }
            return fullPath;
        }

        private string ResolveDirectory(string? virtualPath)
        {
            var fullPath = Resolve(virtualPath);
            if (File.Exists(fullPath))
            {
                throw new FileServiceException(400, "Not a folder: " + ToVirtualPath(fullPath));
            }
            if (!Directory.Exists(fullPath) || ContainsLink(fullPath))
            {
                throw new FileServiceException(404, "Not found: " + (virtualPath ?? "/"));
            }
            return fullPath;
        }

        private static string[] Split(string? virtualPath)
        {
            if (string.IsNullOrWhiteSpace(virtualPath))
            {
                return Array.Empty<string>();
            }
            if (virtualPath.Contains('\0'))
            {
                throw new FileServiceException(400, "Path contains invalid characters");
            }
            var segments = virtualPath.Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
            if (segments.Any(s => s == "." || s == ".."))
            {
                throw new FileServiceException(400, OutsideRootMessage);
            }
            return segments;
        }

        private bool IsInsideRoot(string fullPath) =>
            fullPath.Equals(_root, PathComparison) ||
            fullPath.StartsWith(_root + Path.DirectorySeparatorChar, PathComparison);

        /// <summary>True when the path, or any folder between it and the root, is a symlink or junction.</summary>
        private bool ContainsLink(string fullPath)
        {
            for (var p = fullPath; p.Length > _root.Length; p = Path.GetDirectoryName(p)!)
            {
                if (File.GetAttributes(p).HasFlag(FileAttributes.ReparsePoint))
                {
                    return true;
                }
            }
            return false;
        }

        private string ToVirtualPath(string fullPath)
        {
            var relative = Path.GetRelativePath(_root, fullPath);
            return relative == "." ? "/" : "/" + relative.Replace(Path.DirectorySeparatorChar, '/');
        }

        // ---- mapping and sorting -----------------------------------------------------------------------------

        private FileEntry ToEntry(FileSystemInfo info) =>
            info is FileInfo file
                ? new FileEntry(file.Name, ToVirtualPath(file.FullName), EntryType.File, file.Length, file.LastWriteTimeUtc)
                : new FileEntry(info.Name, ToVirtualPath(info.FullName), EntryType.Folder, null, info.LastWriteTimeUtc);

        /// <summary>Folders always come first. Ties are broken by name so the order is stable.</summary>
        private static void SortEntries(List<FileEntry> entries, SortField sort, SortDirection dir)
        {
            var sign = dir == SortDirection.Desc ? -1 : 1;
            entries.Sort((a, b) => {
                if (a.Type != b.Type)
                {
                    return a.Type == EntryType.Folder ? -1 : 1;
                }
                var byName = string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
                var primary = sort switch
                {
                    SortField.Size => Nullable.Compare(a.Size, b.Size),
                    SortField.Modified => a.Modified.CompareTo(b.Modified),
                    _ => byName
                };
                if (primary != 0)
                {
                    return sign * primary;
                }
                return sort == SortField.Name ? 0 : byName;
            });
        }
    }
}
