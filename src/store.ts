import * as fs from 'fs';
import * as path from 'path';
import { AppData, Contact, ScheduledMessage } from './types';

const DATA_FILE = path.join(__dirname, '..', 'data', 'app-data.json');

const DEFAULT_DATA: AppData = {
  contacts: [],
  messages: [],
};

function ensureDataDir(): void {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadData(): AppData {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    saveData(DEFAULT_DATA);
    return { ...DEFAULT_DATA };
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  return JSON.parse(raw) as AppData;
}

export function saveData(data: AppData): void {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function addContact(contact: Contact): void {
  const data = loadData();
  data.contacts.push(contact);
  saveData(data);
}

export function removeContact(id: string): boolean {
  const data = loadData();
  const idx = data.contacts.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  data.contacts.splice(idx, 1);
  // Also cancel pending messages for this contact
  data.messages = data.messages.map((m) => {
    if (m.contactId === id && m.status === 'scheduled') {
      return { ...m, status: 'cancelled' as const };
    }
    return m;
  });
  saveData(data);
  return true;
}

export function getContacts(): Contact[] {
  return loadData().contacts;
}

export function getContact(id: string): Contact | undefined {
  return loadData().contacts.find((c) => c.id === id);
}

export function addMessage(message: ScheduledMessage): void {
  const data = loadData();
  data.messages.push(message);
  saveData(data);
}

export function updateMessage(
  id: string,
  updates: Partial<ScheduledMessage>
): void {
  const data = loadData();
  const idx = data.messages.findIndex((m) => m.id === id);
  if (idx !== -1) {
    data.messages[idx] = { ...data.messages[idx], ...updates };
    saveData(data);
  }
}

export function getMessages(): ScheduledMessage[] {
  return loadData().messages;
}

export function getNotifyServiceSid(): string | undefined {
  return loadData().notifyServiceSid;
}

export function setNotifyServiceSid(sid: string): void {
  const data = loadData();
  data.notifyServiceSid = sid;
  saveData(data);
}
