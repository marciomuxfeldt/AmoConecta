---
name: Supabase connector limits
description: What the Replit Supabase connector can and cannot do for this project.
---

The connected Supabase integration is suitable for authenticated REST/PostgREST requests from the application and agent sandbox, but it does not expose a direct SQL/DDL execution surface.

**Why:** The AmoConecta foundation migration must therefore be kept as a checked-in SQL file and applied through the Supabase SQL Editor unless a future connection with SQL access is added.

**How to apply:** Do not claim a remote schema migration ran when only the migration file was created. After the SQL Editor applies the migration, validate the `campanha` table through the REST endpoint before treating the campaign list as fully connected.