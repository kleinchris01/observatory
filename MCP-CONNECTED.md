# Observability MCP Connection

This workspace is a Forge Confluence app repository for the Observatory Jira custom field governance macro.

## Current Atlassian MCP connection

The editor environment already has an MCP connection to:

- `https://ford-advev.atlassian.net`

Available scopes for the connected Atlassian resource:

- `read:jira-work`
- `write:jira-work`
- `read:comment:confluence`
- `write:comment:confluence`
- `read:confluence-user`
- `read:page:confluence`
- `read:space:confluence`
- `search:confluence`

## What this means

- There is no existing MCP server implementation in this repo.
- The project remains a Forge app with `manifest.yml`, not a standalone MCP server.
- The MCP tooling can still be used from VS Code for Atlassian automation and site access.

## Recommended next step

Use the existing connection to run Atlassian actions from the editor or to add repository automation that interacts with Jira/Confluence through MCP tools.