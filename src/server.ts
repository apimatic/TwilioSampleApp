import express from 'express';
import session from 'express-session';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { validateAndFormatPhone } from './phone';
import {
  addContact,
  removeContact,
  getContacts,
  getMessages,
  updateMessage,
  addMessage,
} from './store';
import {
  createTwilioClientBundle,
  createSmsBinding,
  sendBirthdaySms,
  isTwilioConfigured,
  ensureNotifyService,
  setSessionClient,
  getSessionClient,
  removeSessionClient,
} from './sms-service';
import {
  scheduleMessagesForContact,
  scheduleAllContacts,
  generateBirthdayMessage,
  interpolateName,
  startScheduler,
} from './scheduler';
import { Contact, ScheduledMessage, SessionCredentials } from './types';

// Extend express-session to include our credentials
declare module 'express-session' {
  interface SessionData {
    credentials?: SessionCredentials;
  }
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// Session middleware
app.use(
  session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'src', 'public')));

// ─── Auth Routes (unprotected) ──────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { accountSid, authToken, messagingServiceSid } = req.body;

  if (!accountSid || !authToken || !messagingServiceSid) {
    res.status(400).json({
      error: 'Account SID, Auth Token, and Messaging Service SID are required.',
    });
    return;
  }

  // Basic format validation
  if (!String(accountSid).startsWith('AC') || String(accountSid).length !== 34) {
    res.status(400).json({
      error: 'Account SID should start with "AC" and be 34 characters long.',
    });
    return;
  }

  const creds: SessionCredentials = {
    accountSid: String(accountSid).trim(),
    authToken: String(authToken).trim(),
    messagingServiceSid: String(messagingServiceSid).trim(),
  };

  try {
    // Create a Twilio client and validate by creating/fetching the notify service
    const bundle = createTwilioClientBundle(creds);
    const sessionId = req.sessionID;
    const serviceSid = await ensureNotifyService(bundle, sessionId);

    if (!serviceSid) {
      res.status(401).json({
        error: 'Could not connect to Twilio. Please check your credentials and Messaging Service SID.',
      });
      return;
    }

    // Store credentials in session and register the client
    creds.notifyServiceSid = serviceSid;
    req.session.credentials = creds;
    setSessionClient(sessionId, bundle);

    res.json({
      success: true,
      accountSid: maskSid(creds.accountSid),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('Login error:', errMsg);
    res.status(401).json({
      error: 'Authentication failed. Please verify your Twilio credentials.',
    });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.sessionID;
  removeSessionClient(sessionId);
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
    }
    res.json({ success: true });
  });
});

app.get('/api/auth/status', (req, res) => {
  const creds = req.session.credentials;
  if (creds) {
    res.json({
      authenticated: true,
      accountSid: maskSid(creds.accountSid),
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ─── Auth Guard Middleware ───────────────────────────────────────

function authGuard(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // Skip auth for auth routes (req.path is relative to mount point /api)
  if (req.path.startsWith('/auth/')) {
    next();
    return;
  }

  if (!req.session.credentials) {
    res.status(401).json({ error: 'Not authenticated. Please log in with your Twilio credentials.' });
    return;
  }

  // Ensure client bundle exists for this session
  const sessionId = req.sessionID;
  if (!getSessionClient(sessionId) && req.session.credentials) {
    // Re-create client bundle from session credentials
    const bundle = createTwilioClientBundle(req.session.credentials);
    setSessionClient(sessionId, bundle);
  }

  next();
}

// Apply auth guard to all /api/* routes except /api/auth/*
app.use('/api', authGuard);

// ─── Helper ─────────────────────────────────────────────────────

function maskSid(sid: string): string {
  if (sid.length <= 8) return sid;
  return sid.substring(0, 6) + '...' + sid.substring(sid.length - 4);
}

function getBundle(req: express.Request) {
  return getSessionClient(req.sessionID);
}

// ─── API Routes ─────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    twilioConfigured: isTwilioConfigured(req.sessionID),
    contactCount: getContacts().length,
    scheduledCount: getMessages().filter((m) => m.status === 'scheduled').length,
    accountSid: req.session.credentials
      ? maskSid(req.session.credentials.accountSid)
      : null,
  });
});

app.get('/api/contacts', (_req, res) => {
  res.json(getContacts());
});

app.post('/api/contacts', async (req, res) => {
  const { name, phone, birthday } = req.body;

  if (!name || !phone || !birthday) {
    res.status(400).json({ error: 'Name, phone, and birthday are required.' });
    return;
  }

  const safeName = String(name).trim();
  if (safeName.length === 0 || safeName.length > 100) {
    res.status(400).json({ error: 'Name must be 1-100 characters.' });
    return;
  }

  const phoneResult = validateAndFormatPhone(String(phone));
  if (!phoneResult.valid || !phoneResult.formatted) {
    res.status(400).json({
      error: phoneResult.error || 'Invalid phone number.',
    });
    return;
  }

  const bdayStr = String(birthday);
  const bdayMatch = bdayStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!bdayMatch) {
    res.status(400).json({ error: 'Birthday must be in YYYY-MM-DD format.' });
    return;
  }

  const month = parseInt(bdayMatch[2], 10);
  const day = parseInt(bdayMatch[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    res.status(400).json({ error: 'Invalid birthday date.' });
    return;
  }

  const existing = getContacts().find(
    (c) => c.phone === phoneResult.formatted
  );
  if (existing) {
    res.status(409).json({
      error: `A contact with this phone number already exists (${existing.name}).`,
    });
    return;
  }

  const contact: Contact = {
    id: uuidv4(),
    name: safeName,
    phone: phoneResult.formatted,
    birthday: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    birthdayFull: bdayStr,
    createdAt: new Date().toISOString(),
  };

  addContact(contact);

  const bundle = getBundle(req);
  if (bundle) {
    await createSmsBinding(bundle, req.sessionID, contact.id, contact.phone);
  }

  const scheduled = scheduleMessagesForContact(contact.id);

  res.status(201).json({
    contact,
    scheduled,
    phoneFormatted: phoneResult.formatted,
    countryHint: phoneResult.countryHint,
  });
});

app.delete('/api/contacts/:id', (req, res) => {
  const removed = removeContact(req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'Contact not found.' });
    return;
  }
  res.json({ success: true });
});

// ─── Message Routes ─────────────────────────────────────────────

app.get('/api/messages', (req, res) => {
  let messages = getMessages();
  const status = req.query.status as string | undefined;
  if (status) {
    messages = messages.filter((m) => m.status === status);
  }
  messages.sort(
    (a, b) =>
      new Date(b.scheduledFor).getTime() - new Date(a.scheduledFor).getTime()
  );
  res.json(messages);
});

app.post('/api/messages/preview', (req, res) => {
  const { name, template } = req.body;
  if (!name) {
    res.status(400).json({ error: 'Name is required for preview.' });
    return;
  }

  const safeName = String(name).trim();
  let messageBody: string;

  if (template) {
    messageBody = interpolateName(String(template), safeName);
  } else {
    messageBody = generateBirthdayMessage(safeName);
  }

  res.json({
    preview: messageBody,
    charCount: messageBody.length,
    smsSegments: Math.ceil(messageBody.length / 160),
    trialNote: isTwilioConfigured(req.sessionID)
      ? 'Note: On a free trial, messages will be prefixed with "Sent from your Twilio trial account - " and can only be sent to verified numbers.'
      : 'Twilio is not configured. Messages will be simulated.',
  });
});

app.post('/api/messages/send-now', async (req, res) => {
  const { contactId, messageBody } = req.body;
  if (!contactId) {
    res.status(400).json({ error: 'contactId is required.' });
    return;
  }

  const contacts = getContacts();
  const contact = contacts.find((c) => c.id === contactId);
  if (!contact) {
    res.status(404).json({ error: 'Contact not found.' });
    return;
  }

  const body = messageBody || generateBirthdayMessage(contact.name);

  const msgRecord: ScheduledMessage = {
    id: uuidv4(),
    contactId: contact.id,
    contactName: contact.name,
    phone: contact.phone,
    messageBody: body,
    scheduledFor: new Date().toISOString(),
    status: 'sending',
    createdAt: new Date().toISOString(),
    year: new Date().getFullYear(),
  };

  addMessage(msgRecord);

  const bundle = getBundle(req);
  const result = await sendBirthdaySms(
    bundle,
    req.sessionID,
    contact.id,
    contact.phone,
    body
  );

  if (result.success) {
    updateMessage(msgRecord.id, {
      status: 'sent',
      notificationSid: result.notificationSid,
      sentAt: new Date().toISOString(),
    });

    setTimeout(() => {
      updateMessage(msgRecord.id, {
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
      });
    }, 5000);

    res.json({
      success: true,
      message: msgRecord,
      notificationSid: result.notificationSid,
    });
  } else {
    updateMessage(msgRecord.id, {
      status: 'failed',
      errorMessage: result.error,
    });
    res.status(500).json({
      success: false,
      error: result.error,
      message: { ...msgRecord, status: 'failed', errorMessage: result.error },
    });
  }
});

app.post('/api/messages/:id/cancel', (req, res) => {
  const messages = getMessages();
  const msg = messages.find((m) => m.id === req.params.id);
  if (!msg) {
    res.status(404).json({ error: 'Message not found.' });
    return;
  }
  if (msg.status !== 'scheduled') {
    res.status(400).json({ error: 'Only scheduled messages can be cancelled.' });
    return;
  }
  updateMessage(msg.id, { status: 'cancelled' });
  res.json({ success: true });
});

app.post('/api/messages/schedule-all', (_req, res) => {
  const scheduled = scheduleAllContacts();
  res.json({ scheduled: scheduled.length, messages: scheduled });
});

// ─── Timeline / Activity Feed ───────────────────────────────────

app.get('/api/timeline', (_req, res) => {
  const messages = getMessages();
  const contacts = getContacts();

  const timeline = messages
    .map((m) => ({
      ...m,
      contactExists: contacts.some((c) => c.id === m.contactId),
    }))
    .sort((a, b) => {
      if (a.status === 'scheduled' && b.status !== 'scheduled') return -1;
      if (b.status === 'scheduled' && a.status !== 'scheduled') return 1;
      return (
        new Date(b.scheduledFor).getTime() -
        new Date(a.scheduledFor).getTime()
      );
    });

  res.json(timeline);
});

// ─── Serve Frontend ─────────────────────────────────────────────

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'src', 'public', 'login.html'));
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'src', 'public', 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  BirthdayBuzz running at http://localhost:${PORT}\n`);
  console.log('  Login with your Twilio credentials at /login\n');

  // Start the birthday scheduler
  startScheduler();
});
