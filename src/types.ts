export interface Contact {
  id: string;
  name: string;
  phone: string; // E.164 format
  birthday: string; // MM-DD format
  birthdayFull: string; // YYYY-MM-DD (original input for display)
  createdAt: string;
}

export type MessageStatus =
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface ScheduledMessage {
  id: string;
  contactId: string;
  contactName: string;
  phone: string;
  messageBody: string;
  scheduledFor: string; // ISO 8601 date-time
  status: MessageStatus;
  notificationSid?: string;
  errorMessage?: string;
  sentAt?: string;
  deliveredAt?: string;
  createdAt: string;
  year: number; // The year this message is scheduled for
}

export interface AppData {
  contacts: Contact[];
  messages: ScheduledMessage[];
  notifyServiceSid?: string;
}

export interface SessionCredentials {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  notifyServiceSid?: string;
}

import {
  Client,
  NotifyV1ServiceApi,
  NotifyV1BindingApi,
  NotifyV1NotificationApi,
} from 'twilio-api-sdk-sdk';

export interface TwilioClientBundle {
  client: Client;
  serviceApi: NotifyV1ServiceApi;
  bindingApi: NotifyV1BindingApi;
  notificationApi: NotifyV1NotificationApi;
  credentials: SessionCredentials;
}
