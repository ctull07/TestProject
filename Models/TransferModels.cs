namespace TestProject.Models
{
    /// <summary>Response for POST /api/files/upload. Name can differ from the uploaded name if it was already taken.</summary>
    public record UploadResult(string Name, string Path, long Size);

    /// <summary>Something ready to stream to the client: a file, or a ZIP built for folders and multiple items.</summary>
    public record DownloadFile(Stream Content, string FileName, string ContentType);
}
