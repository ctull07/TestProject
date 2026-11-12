using Microsoft.Extensions.Options;
using TestProject.Models;

namespace TestProject.Services
{
    public class FileService : IFileService
    {
        private const int SearchLimit = 10_000;
        private const string OutsideRootMessage = "Path escapes the configured home directory";

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

            var enumeration = new EnumerationOptions
            {
                RecurseSubdirectories = searching,
                IgnoreInaccessible = true,
                // Skipping reparse points (symlinks, junctions) keeps a link inside the root from leading outside it.
                AttributesToSkip = FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint
            };

            // Lazy enumeration: the file system is read once, and attributes come back with each entry.
            IEnumerable<FileSystemInfo> infos = new DirectoryInfo(fullPath).EnumerateFileSystemInfos("*", enumeration);
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
