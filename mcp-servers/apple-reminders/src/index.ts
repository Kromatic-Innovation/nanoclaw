#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runJxa } from "./jxa.js";
import {
  LIST_ALL_LISTS,
  GET_REMINDERS,
  CREATE_REMINDER,
  COMPLETE_REMINDER,
  CREATE_LIST,
  SEARCH_REMINDERS,
  GET_REMINDER_DETAIL,
} from "./scripts.js";

const server = new McpServer({
  name: "apple-reminders",
  version: "1.0.0",
});

// --- Tools ---

server.tool(
  "list_reminder_lists",
  "List all reminder lists in Apple Reminders",
  {},
  async () => {
    const lists = await runJxa<Array<{ id: string; name: string }>>(
      LIST_ALL_LISTS
    );
    return { content: [{ type: "text", text: JSON.stringify(lists, null, 2) }] };
  }
);

server.tool(
  "get_reminders",
  "Get reminders from a specific list",
  {
    list: z.string().describe("Name of the reminder list"),
    include_completed: z
      .boolean()
      .default(false)
      .describe("Include completed reminders (default: false)"),
  },
  async ({ list, include_completed }) => {
    const reminders = await runJxa(GET_REMINDERS(list, include_completed));
    return {
      content: [{ type: "text", text: JSON.stringify(reminders, null, 2) }],
    };
  }
);

server.tool(
  "create_reminder",
  "Create a new reminder in a specific list",
  {
    list: z.string().describe("Name of the reminder list"),
    name: z.string().describe("Title of the reminder"),
    body: z.string().optional().describe("Notes/body text for the reminder"),
    due_date: z
      .string()
      .optional()
      .describe("Due date in ISO 8601 format (e.g. 2026-03-25T10:00:00)"),
    priority: z
      .number()
      .min(0)
      .max(9)
      .optional()
      .describe("Priority: 0 = none, 1-4 = high, 5 = medium, 6-9 = low"),
    flagged: z.boolean().optional().describe("Flag the reminder"),
  },
  async ({ list, name, body, due_date, priority, flagged }) => {
    const reminder = await runJxa(
      CREATE_REMINDER(list, name, {
        body,
        dueDate: due_date,
        priority,
        flagged,
      })
    );
    return {
      content: [{ type: "text", text: JSON.stringify(reminder, null, 2) }],
    };
  }
);

server.tool(
  "complete_reminder",
  "Mark a reminder as complete or incomplete",
  {
    list: z.string().describe("Name of the reminder list"),
    reminder_id: z.string().describe("ID of the reminder"),
    completed: z
      .boolean()
      .default(true)
      .describe("Set to true to complete, false to uncomplete"),
  },
  async ({ list, reminder_id, completed }) => {
    const result = await runJxa(COMPLETE_REMINDER(list, reminder_id, completed));
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "create_list",
  "Create a new reminder list",
  {
    name: z.string().describe("Name for the new list"),
  },
  async ({ name }) => {
    const list = await runJxa(CREATE_LIST(name));
    return {
      content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
    };
  }
);

server.tool(
  "search_reminders",
  "Search reminders across all lists by text in name or notes",
  {
    query: z.string().describe("Search text (case-insensitive)"),
    include_completed: z
      .boolean()
      .default(false)
      .describe("Include completed reminders in search"),
  },
  async ({ query, include_completed }) => {
    const results = await runJxa(SEARCH_REMINDERS(query, include_completed));
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

server.tool(
  "get_reminder_detail",
  "Get full details of a specific reminder including dates and metadata",
  {
    list: z.string().describe("Name of the reminder list"),
    reminder_id: z.string().describe("ID of the reminder"),
  },
  async ({ list, reminder_id }) => {
    const detail = await runJxa(GET_REMINDER_DETAIL(list, reminder_id));
    return {
      content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
    };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
