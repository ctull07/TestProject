using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.Features;
using TestProject.Models;
using TestProject.Services;
using Microsoft.Extensions.Options;

namespace TestProject
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            // Add services to the container.

            var section = builder.Configuration.GetSection(FileBrowserOptions.SectionName);
            builder.Services.Configure<FileBrowserOptions>(section);
            builder.Services.AddSingleton<IFileService, FileService>();

            // One setting caps uploads at both layers: Kestrel's request body and multipart form parsing.
            var maxUploadBytes = (section.Get<FileBrowserOptions>() ?? new FileBrowserOptions()).MaxUploadBytes;
            builder.WebHost.ConfigureKestrel(kestrel => kestrel.Limits.MaxRequestBodySize = maxUploadBytes);
            builder.Services.Configure<FormOptions>(form => form.MultipartBodyLengthLimit = maxUploadBytes);

            builder.Services
                .AddControllers(options => options.Filters.Add<FileServiceExceptionFilter>())
                .AddJsonOptions(options =>
                    // Send enums as "folder" / "file" / "asc" instead of 0 / 1.
                    options.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)));

            var app = builder.Build();

            // Configure the HTTP request pipeline.

            app.UseHttpsRedirection();


            app.UseDefaultFiles();   // serves wwwroot/index.html at "/"
            app.UseStaticFiles();

            // A too-large upload would otherwise fail inside form binding and come back as a vague 400.
            // Browsers and API clients send Content-Length up front, so refuse it here with a clear 413.
            var uploadLimit = app.Services.GetRequiredService<IOptions<FileBrowserOptions>>().Value.MaxUploadBytes;
            app.Use(async (context, next) =>
            {
                if (HttpMethods.IsPost(context.Request.Method)
                    && context.Request.Path.Equals("/api/files/upload", StringComparison.OrdinalIgnoreCase)
                    && context.Request.ContentLength > uploadLimit)
                {
                    await Results.Problem(
                        title: "The file is larger than the server allows",
                        statusCode: StatusCodes.Status413PayloadTooLarge).ExecuteAsync(context);
                    return;
                }
                await next();
            });

            app.MapControllers();

            // Deep links such as /browse/Documents are client-side routes. Serve the app for them,
            // on this prefix only, so a mistyped /api/... URL still returns a real 404.
            app.MapFallbackToFile("/browse", "index.html");
            app.MapFallbackToFile("/browse/{*path}", "index.html");

            app.Run();
        }
    }
}
