# Sample

Sample is a small, framework-neutral demonstration App. It exists so an App author can see a
manifest, visual entrypoint, operation controller, optional permission, Space-scoped setting, and
private App storage working together in one package.

Sample notes are records in this App's private storage for the current Space. They are not files,
cannot be opened by another App, and never leave Penkra. Use Sample only when that intentionally
limited destination matches the user's request.

The `display-name` setting affects the Sample home page and is stored per Space. It does not alter
saved notes. Opening an Apps registry listing is navigation only: it does not install, enable, or
grant permissions to the selected App.

Each operation's leaf help contains the choices and recovery rules specific to that operation.
