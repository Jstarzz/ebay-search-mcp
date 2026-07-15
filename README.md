# ebay-search-mcp

## Build

Run `npm run build` to compile the MCP server into `dist/index.js`.

## Environment

Copy [.env.example](.env.example) to `.env` in the project root and fill in your values:

```env
EBAY_CLIENT_ID=your-client-id
EBAY_CLIENT_SECRET=your-client-secret
EBAY_MARKETPLACE_ID=EBAY_US
```

The server loads `.env` from the repository root, so Claude Desktop can launch it from anywhere.

## Claude Desktop

Point Claude Desktop at the built JavaScript file, not the TypeScript source. Replace the placeholder path with the absolute path to your clone:

```json
{
    "mcpServers": {
        "ebay-search": {
            "command": "node",
            "args": ["/absolute/path/to/ebay-search-mcp/dist/index.js"]
        }
    }
}
```

If Claude Desktop cannot find `node`, replace `command` with the full path to your Node executable. On Windows, use `where node`; on macOS/Linux, use `which node`.

After updating the config, run `npm run build` and restart Claude Desktop.