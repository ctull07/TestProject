using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace TestProject.Services
{
    /// <summary>
    /// Turns expected file-system failures into RFC 7807 problem responses so controllers stay free of try/catch.
    /// The client reads "title" for the message.
    /// </summary>
    public class FileServiceExceptionFilter : IExceptionFilter
    {
        public void OnException(ExceptionContext context)
        {
            int status;
            string title;

            if (context.Exception is FileServiceException ex)
            {
                status = ex.StatusCode;
                title = ex.Message;
            }
            else if (context.Exception is UnauthorizedAccessException)
            {
                // The framework message contains the server's real path, so use a fixed one.
                status = StatusCodes.Status403Forbidden;
                title = "Access to this location is denied";
            }
            else
            {
                return;
            }

            context.Result = new ObjectResult(new ProblemDetails { Status = status, Title = title })
            {
                StatusCode = status
            };
            context.ExceptionHandled = true;
        }
    }
}
