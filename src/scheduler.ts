import * as cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { getContacts, getMessages, addMessage, updateMessage } from './store';
import { sendBirthdaySms, getFirstActiveClient } from './sms-service';
import { ScheduledMessage } from './types';

const BIRTHDAY_MESSAGES = [
  'Happy Birthday, {{name}}! Wishing you a day filled with joy, laughter, and all the things that make you smile. Have an amazing year ahead!',
  'It\'s your special day, {{name}}! May this birthday bring you endless happiness and wonderful surprises. Cheers to another incredible year!',
  'Happy Birthday, {{name}}! Here\'s to celebrating YOU today. May your day be as wonderful and bright as you are!',
  'Wishing you the happiest of birthdays, {{name}}! May all your dreams come true this year. Enjoy every moment of your special day!',
  'Happy Birthday, {{name}}! Another year of being awesome starts today. Hope your day is full of cake, fun, and unforgettable memories!',
];

export function generateBirthdayMessage(name: string): string {
  const template =
    BIRTHDAY_MESSAGES[Math.floor(Math.random() * BIRTHDAY_MESSAGES.length)];
  return interpolateName(template, name);
}

export function interpolateName(template: string, name: string): string {
  const safeName = name
    .replace(/[<>]/g, '')
    .trim();
  return template.replace(/\{\{name\}\}/g, safeName);
}

export function getNextBirthdayDate(
  birthdayMMDD: string,
  referenceDate?: Date
): Date {
  const ref = referenceDate || new Date();
  const [month, day] = birthdayMMDD.split('-').map(Number);
  const thisYear = ref.getFullYear();

  const thisYearBday = new Date(thisYear, month - 1, day, 9, 0, 0);

  if (thisYearBday <= ref) {
    return new Date(thisYear + 1, month - 1, day, 9, 0, 0);
  }

  return thisYearBday;
}

export function scheduleMessagesForContact(contactId: string): ScheduledMessage | null {
  const contacts = getContacts();
  const contact = contacts.find((c) => c.id === contactId);
  if (!contact) return null;

  const messages = getMessages();
  const now = new Date();
  const nextBirthday = getNextBirthdayDate(contact.birthday, now);
  const year = nextBirthday.getFullYear();

  const existing = messages.find(
    (m) =>
      m.contactId === contactId &&
      m.year === year &&
      m.status === 'scheduled'
  );
  if (existing) return existing;

  const messageBody = generateBirthdayMessage(contact.name);
  const message: ScheduledMessage = {
    id: uuidv4(),
    contactId: contact.id,
    contactName: contact.name,
    phone: contact.phone,
    messageBody,
    scheduledFor: nextBirthday.toISOString(),
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    year,
  };

  addMessage(message);
  return message;
}

export function scheduleAllContacts(): ScheduledMessage[] {
  const contacts = getContacts();
  const scheduled: ScheduledMessage[] = [];

  for (const contact of contacts) {
    const msg = scheduleMessagesForContact(contact.id);
    if (msg) scheduled.push(msg);
  }

  return scheduled;
}

async function processDueMessages(): Promise<void> {
  const messages = getMessages();
  const now = new Date();

  // Use the first active session client for scheduled sends
  const bundle = getFirstActiveClient();

  for (const msg of messages) {
    if (msg.status !== 'scheduled') continue;

    const scheduledTime = new Date(msg.scheduledFor);
    if (scheduledTime <= now) {
      console.log(
        `Processing birthday message for ${msg.contactName} (${msg.phone})`
      );
      updateMessage(msg.id, { status: 'sending' });

      const result = await sendBirthdaySms(
        bundle,
        'scheduler',
        msg.contactId,
        msg.phone,
        msg.messageBody
      );

      if (result.success) {
        updateMessage(msg.id, {
          status: 'sent',
          notificationSid: result.notificationSid,
          sentAt: new Date().toISOString(),
        });

        setTimeout(() => {
          updateMessage(msg.id, {
            status: 'delivered',
            deliveredAt: new Date().toISOString(),
          });
        }, 5000);

        const contacts = getContacts();
        const contact = contacts.find((c) => c.id === msg.contactId);
        if (contact) {
          scheduleMessagesForContact(contact.id);
        }
      } else {
        updateMessage(msg.id, {
          status: 'failed',
          errorMessage: result.error,
        });
      }
    }
  }
}

export function startScheduler(): void {
  cron.schedule('* * * * *', async () => {
    try {
      await processDueMessages();
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  });

  scheduleAllContacts();

  console.log('Birthday message scheduler started (checks every minute).');
}
