# File Browser

A web API and single page app for browsing, searching and managing the files in a server-side directory.
The API is ASP.NET Core (.NET 8). The UI is vanilla JavaScript (ES modules) that renders all HTML in the
browser. The server returns JSON only.

## Run it

Requires the .NET 8 SDK.

```
cd TestProject
dotnet run
```

Open the HTTPS address printed in the console. The file browser is the page itself. A starter set of files
is in `SampleFiles/`.

The project builds with `dotnet build`, Visual Studio 2022, Rider or VS Code. Use the `TestProject` launch
profile (not IIS Express).

## Configuration

Settings live in `appsettings.json` under `FileBrowser`:

| Setting          | Default        | Meaning                                                                    |
|------------------|----------------|----------------------------------------------------------------------------|
| `RootPath`       | `SampleFiles`  | The home directory the API exposes. A relative path is resolved against the project folder. |
| `MaxUploadBytes` | `1073741824`   | Largest single upload (1 GB). Applied to Kestrel and to multipart parsing. |

Any setting can be overridden without editing the file, for example:

```
FileBrowser__RootPath=/srv/files dotnet run          # Linux and macOS
set FileBrowser__RootPath=D:\Shared && dotnet run    # Windows cmd
```

## Features

- Browse folders; search by name in the current folder and everything below it
- Sort by name, size or modified date
- Counts of folders and files and total file size for the current view, plus the current selection
- Deep-linkable: the folder, search text and sort order are in the URL
- Upload (button or drag and drop, with progress) and download (single file, folder or selection as a ZIP)
- Delete, move and copy files and folders, with a confirmation and a folder picker
- Handles large folders: only the visible rows are in the DOM

## URL pattern

```
/browse/Documents/Reports?q=budget&sort=size&dir=desc
```

- The path after `/browse` is the folder.
- `q` is the search text. `sort` is `name`, `size` or `modified`. `dir` is `asc` or `desc`.
- Defaults are omitted, so `/browse` is the home directory sorted by name. Opening `/` rewrites to `/browse`.
- The server returns the app for any `/browse/...` URL, so a deep link still works after a reload.
  Other unknown URLs, including `/api/...`, return a real 404.

## API

All paths are virtual: `/` is the configured home directory. Failures return
[problem details](https://www.rfc-editor.org/rfc/rfc7807) JSON, where `title` is the message to show.

| Method and URL | Purpose |
|----------------|---------|
| `GET /api/files?path=&q=&sort=&dir=` | List a folder, or search it and everything below. Returns entries plus `totals` (`folders`, `files`, `bytes`). |
| `POST /api/files/upload?path=` | Upload one file (multipart field `file`). A taken name gets a suffix: `a (1).txt`. |
| `GET /api/files/download?path=` | One file is sent as is. A folder, or several `path` values, return a ZIP. |
| `POST /api/files/download` | Same, with `path` form fields, for selections too long for a URL. |
| `POST /api/files/delete` | Body `{ "paths": [...] }`. |
| `POST /api/files/move` | Body `{ "paths": [...], "destination": "/Projects" }`. Never overwrites. |
| `POST /api/files/copy` | Same body. A taken name gets a suffix. |

Delete, move and copy return `{ succeeded, skipped, failed: [{ path, error }] }`. Each item is handled on its
own, so one locked file is reported without stopping the rest. Problems with the whole request (a bad
destination, moving a folder into itself) are rejected before anything changes.

## Code layout

```
Controllers/FilesController.cs     thin HTTP layer, no logic
Services/FileService.cs            all file-system logic and path safety
Services/FileServiceExceptionFilter.cs   maps expected failures to 400/404/409
Models/                            listing, transfer and options types
wwwroot/js/
  main.js                          mounts the component and starts it
  FileBrowser.js                   the component: state, rendering, events
  UploadQueue.js                   concurrent uploads with per-file progress
  dialogs.js                       delete confirmation and folder picker
  router.js                        URL <-> state
  api.js                           the only code that talks to the server
  format.js                        pure helpers
```

## Design decisions

**One place turns a request path into a real path.** `FileService.Resolve` rejects `..` and rooted segments,
then checks that the final path is still inside the home directory. Every endpoint goes through it, so
there is one thing to audit. Symlinks and junctions are never followed, in listings, ZIPs, copies or lookups.

**The controller has no logic and no try/catch.** The service throws `FileServiceException` carrying a status
code, and an exception filter turns it into a response. Error messages never contain the server's real paths.

**Nothing is overwritten.** Uploads and copies pick a free name using `FileMode.CreateNew` or `File.Copy`
without overwrite, so two simultaneous uploads of the same name cannot collide. Moves refuse a clash.

**Uploads are one request per file.** That gives per-file progress and per-file errors, bounded memory, and
three transfers at a time. A failed or cancelled upload deletes its partial file.

**ZIPs are built in a temporary file.** The response then has a known length and supports resume, and a
failure part way is a clean error instead of a corrupt download. The cost is that the first byte waits for
the whole archive. Streaming the ZIP directly is the next step if that matters.

**Folder sizes load after the list, one request per folder, so a large tree never delays browsing.** They count 
the same files the list shows (hidden and system files excluded) and are cached for 60 seconds. Sorting by 
size orders files only; folders stay first, sorted by name.

**The UI state is the URL.** `toUrl` and `fromLocation` are exact inverses. Folders and breadcrumbs are real
links, so open-in-new-tab and copy-link work. Search and sort replace the history entry so Back does not step
through every keystroke.

**Large folders stay fast.** The list renders only the rows near the viewport, using fixed row heights, so a
folder with 50,000 files costs the same to scroll as one with 50. A newer request cancels an older one, so a
slow response can never overwrite a newer view.

**All file names are untrusted.** Every name is escaped before it goes into markup.

## Known limits and next steps

- No authentication or authorization. Anyone who can reach the server can read and change the home directory.
- Search results are capped at 10,000 and flagged as truncated. Very large result sets would need paging.
- Folder sizes are not shown (see above). A cached or on-demand size would fit here.
- Uploading folders is not supported. Dropped folders are skipped with a message.
- A very large copy or delete runs inside one request. A background job with progress would suit it better.
- Move uses the file system's rename, so it is atomic on one volume. Across volumes a folder move can fail.
- Not included: hosting the browser inside a dialog opened by a button. `FileBrowser` only needs a root
  element and a router, so it could be mounted in a dialog without changes to the API.
