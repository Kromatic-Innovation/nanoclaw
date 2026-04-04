/**
 * JXA scripts for Apple Reminders.
 *
 * Each script is a self-contained JXA program that returns JSON via
 * JSON.stringify(). The host calls these via `osascript -l JavaScript`.
 *
 * Reminders.app JXA object model:
 *   Application("Reminders")
 *     .lists[]           → ReminderList  { name, id }
 *     .lists[].reminders[] → Reminder    { name, id, body, completed, dueDate, priority, ... }
 */

export const LIST_ALL_LISTS = `
  const app = Application("Reminders");
  const lists = app.lists();
  JSON.stringify(lists.map(l => ({
    id: l.id(),
    name: l.name()
  })));
`;

export const GET_REMINDERS = (
  listName: string,
  includeCompleted: boolean
) => `
  const app = Application("Reminders");
  const list = app.lists.byName(${JSON.stringify(listName)});
  const reminders = list.reminders();
  const results = reminders
    .filter(r => ${includeCompleted ? "true" : "!r.completed()"})
    .map(r => ({
      id: r.id(),
      name: r.name(),
      body: r.body(),
      completed: r.completed(),
      dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
      priority: r.priority(),
      flagged: r.flagged()
    }));
  JSON.stringify(results);
`;

export const CREATE_REMINDER = (
  listName: string,
  name: string,
  opts: { body?: string; dueDate?: string; priority?: number; flagged?: boolean }
) => {
  const props: string[] = [`name: ${JSON.stringify(name)}`];
  if (opts.body) props.push(`body: ${JSON.stringify(opts.body)}`);
  if (opts.dueDate) props.push(`dueDate: new Date(${JSON.stringify(opts.dueDate)})`);
  if (opts.priority !== undefined) props.push(`priority: ${opts.priority}`);
  if (opts.flagged !== undefined) props.push(`flagged: ${opts.flagged}`);

  return `
    const app = Application("Reminders");
    const list = app.lists.byName(${JSON.stringify(listName)});
    const r = app.Reminder({${props.join(", ")}});
    list.reminders.push(r);
    JSON.stringify({
      id: r.id(),
      name: r.name(),
      body: r.body(),
      completed: r.completed(),
      dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
      priority: r.priority(),
      flagged: r.flagged()
    });
  `;
};

export const COMPLETE_REMINDER = (listName: string, reminderId: string, completed: boolean) => `
  const app = Application("Reminders");
  const list = app.lists.byName(${JSON.stringify(listName)});
  const reminders = list.reminders();
  const r = reminders.find(r => r.id() === ${JSON.stringify(reminderId)});
  if (!r) throw new Error("Reminder not found: " + ${JSON.stringify(reminderId)});
  r.completed = ${completed};
  JSON.stringify({
    id: r.id(),
    name: r.name(),
    completed: r.completed()
  });
`;

export const CREATE_LIST = (name: string) => `
  const app = Application("Reminders");
  const list = app.ReminderList({name: ${JSON.stringify(name)}});
  app.lists.push(list);
  JSON.stringify({
    id: list.id(),
    name: list.name()
  });
`;

export const SEARCH_REMINDERS = (query: string, includeCompleted: boolean) => `
  const app = Application("Reminders");
  const q = ${JSON.stringify(query.toLowerCase())};
  const results = [];
  const lists = app.lists();
  for (const list of lists) {
    const reminders = list.reminders();
    for (const r of reminders) {
      if (${includeCompleted ? "true" : "!r.completed()"}) {
        const name = (r.name() || "").toLowerCase();
        const body = (r.body() || "").toLowerCase();
        if (name.includes(q) || body.includes(q)) {
          results.push({
            id: r.id(),
            name: r.name(),
            body: r.body(),
            completed: r.completed(),
            dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
            priority: r.priority(),
            flagged: r.flagged(),
            list: list.name()
          });
        }
      }
    }
  }
  JSON.stringify(results);
`;

export const GET_REMINDER_DETAIL = (listName: string, reminderId: string) => `
  const app = Application("Reminders");
  const list = app.lists.byName(${JSON.stringify(listName)});
  const reminders = list.reminders();
  const r = reminders.find(r => r.id() === ${JSON.stringify(reminderId)});
  if (!r) throw new Error("Reminder not found: " + ${JSON.stringify(reminderId)});
  JSON.stringify({
    id: r.id(),
    name: r.name(),
    body: r.body(),
    completed: r.completed(),
    dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
    completionDate: r.completionDate() ? r.completionDate().toISOString() : null,
    creationDate: r.creationDate() ? r.creationDate().toISOString() : null,
    modificationDate: r.modificationDate() ? r.modificationDate().toISOString() : null,
    priority: r.priority(),
    flagged: r.flagged()
  });
`;
