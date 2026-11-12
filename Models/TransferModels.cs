namespace TestProject.Models {
    /// <summary>Response for POST /api/files/upload. Name can differ from the uploaded name if it was already taken.</summary>
    public record UploadResult(string Name, string Path, long Size);

    /// <summary>Something ready to stream to the client: a file, or a ZIP built for folders and multiple items.</summary>
    public record DownloadFile(Stream Content, string FileName, string ContentType);

    /// <summary>Request body for POST /api/files/delete.</summary>
    public record PathsRequest(IReadOnlyList<string>? Paths);

    /// <summary>Request body for POST /api/files/move and /api/files/copy.</summary>
    public record TransferRequest(IReadOnlyList<string>? Paths, string? Destination);

    /// <summary>One item that a batch operation could not handle, and why.</summary>
    public record ItemFailure(string Path, string Error);

    /// <summary>
    /// Outcome of delete, move or copy. Each item is handled on its own, so one locked file does not stop the
    /// rest. Skipped counts items a move left alone because they were already in the destination.
    /// </summary>
    public record OperationResult(int Succeeded, int Skipped, IReadOnlyList<ItemFailure> Failed);
}
