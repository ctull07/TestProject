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
    }
}
