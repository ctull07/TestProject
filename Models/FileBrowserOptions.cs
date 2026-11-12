namespace TestProject.Models
{
    /// <summary>Bound from the "FileBrowser" section of appsettings.json.</summary>
    public class FileBrowserOptions
    {
        public const string SectionName = "FileBrowser";

        /// <summary>
        /// Server-side home directory that the API is allowed to expose.
        /// A relative path resolves against the project's content root.
        /// Override per machine with the FileBrowser__RootPath environment variable.
        /// </summary>
        public string RootPath { get; set; } = "SampleFiles";

        /// <summary>Largest single upload in bytes. Applied to both Kestrel and multipart form parsing.</summary>
        public long MaxUploadBytes { get; set; } = 1024L * 1024 * 1024;
    }
}
