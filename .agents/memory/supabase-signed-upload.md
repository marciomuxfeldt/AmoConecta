---
name: Supabase signed upload browser body
description: Browser uploads to Supabase signed upload URLs must match the storage SDK request shape.
---

Use the signed URL returned by `createSignedUploadUrl` with a `PUT` whose body is `FormData`, including `cacheControl` and the file under the empty field name. Sending the raw `File` body does not match the SDK's signed-upload request.

**Why:** The Supabase Storage client implements `uploadToSignedUrl` for Blob/File uploads as multipart form data, even though the transport method is `PUT`.

**How to apply:** Keep file bytes in the browser-to-Storage request and do not proxy them through the application API.