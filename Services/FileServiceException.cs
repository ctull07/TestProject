namespace TestProject.Services
{
    /// <summary>An expected failure that maps directly onto an HTTP status code.</summary>
    public class FileServiceException : Exception
    {
        public int StatusCode { get; }

        public FileServiceException(int statusCode, string message) : base(message)
        {
            StatusCode = statusCode;
        }
    }
}
