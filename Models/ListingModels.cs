namespace TestProject.Models
{
    public enum EntryType { Folder, File }

    public enum SortField { Name, Size, Modified }

    public enum SortDirection { Asc, Desc }

    /// <summary>One file or folder. Size is null for folders.</summary>
    public record FileEntry(string Name, string Path, EntryType Type, long? Size, DateTime Modified);

    /// <summary>Counts and total file bytes for everything in the current view.</summary>
    public record ListingTotals(int Folders, int Files, long Bytes);

    /// <summary>Response for GET /api/files/size: everything beneath one folder, at any depth.</summary>
    public record FolderSize(string Path, long Bytes, int Files, int Folders);

    /// <summary>Response for GET /api/files: a folder listing, or search results beneath that folder.</summary>
    public record DirectoryListing(
        string Path,
        string? Parent,
        string Query,
        SortField Sort,
        SortDirection Dir,
        ListingTotals Totals,
        bool Truncated,
        IReadOnlyList<FileEntry> Entries);
}