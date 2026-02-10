import {
  ApiError,
  BindingBindingTyp2,
  Client,
  Environment,
  LogLevel,
  NotifyV1BindingApi,
  NotifyV1NotificationApi,
  NotifyV1ServiceApi,
} from 'twilio-api-sdk-sdk';
import { getNotifyServiceSid, setNotifyServiceSid } from './store';
import { SessionCredentials, TwilioClientBundle } from './types';

export interface SmsResult {
  success: boolean;
  notificationSid?: string;
  error?: string;
}

// ─── Per-session client factory ──────────────────────────────────

export function createTwilioClientBundle(creds: SessionCredentials): TwilioClientBundle {
  const client = new Client({
    accountSidAuthTokenCredentials: {
      username: creds.accountSid,
      password: creds.authToken,
    },
    timeout: 30000,
    environment: Environment.Production,
    logging: {
      logLevel: LogLevel.Warn,
      logRequest: { logBody: false },
      logResponse: { logHeaders: false },
    },
  });

  return {
    client,
    serviceApi: new NotifyV1ServiceApi(client),
    bindingApi: new NotifyV1BindingApi(client),
    notificationApi: new NotifyV1NotificationApi(client),
    credentials: creds,
  };
}

// ─── Active session clients ──────────────────────────────────────

const activeClients = new Map<string, TwilioClientBundle>();

export function setSessionClient(sessionId: string, bundle: TwilioClientBundle): void {
  activeClients.set(sessionId, bundle);
}

export function getSessionClient(sessionId: string): TwilioClientBundle | undefined {
  return activeClients.get(sessionId);
}

export function removeSessionClient(sessionId: string): void {
  activeClients.delete(sessionId);
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeClients.keys());
}

export function getFirstActiveClient(): TwilioClientBundle | undefined {
  const first = activeClients.values().next();
  return first.done ? undefined : first.value;
}

// ─── Notify service management ───────────────────────────────────

const sessionNotifyServiceSids = new Map<string, string>();

export async function ensureNotifyService(bundle: TwilioClientBundle, sessionId: string): Promise<string | null> {
  // Check in-memory cache for this session
  const cached = sessionNotifyServiceSids.get(sessionId);
  if (cached) return cached;

  // Check credentials for a pre-set notify service SID
  if (bundle.credentials.notifyServiceSid) {
    sessionNotifyServiceSids.set(sessionId, bundle.credentials.notifyServiceSid);
    return bundle.credentials.notifyServiceSid;
  }

  // Check persistent store
  const stored = getNotifyServiceSid();
  if (stored) {
    sessionNotifyServiceSids.set(sessionId, stored);
    console.log('Using existing Notify Service:', stored);
    return stored;
  }

  const messagingServiceSid = bundle.credentials.messagingServiceSid;
  if (!messagingServiceSid) {
    console.warn('No messagingServiceSid. Cannot create Notify Service.');
    return null;
  }

  try {
    const response = await bundle.serviceApi.createService(
      'Birthday SMS Service',
      undefined, // apnCredentialSid
      undefined, // gcmCredentialSid
      messagingServiceSid,
      undefined, // facebookMessengerPageId
      undefined, // defaultApnNotificationProtocolVersion
      undefined, // defaultGcmNotificationProtocolVersion
      undefined, // fcmCredentialSid
      undefined, // defaultFcmNotificationProtocolVersion
      true, // logEnabled
      undefined, // alexaSkillId
      undefined, // defaultAlexaNotificationProtocolVersion
      undefined, // deliveryCallbackUrl
      true // deliveryCallbackEnabled
    );

    if (response.result && response.result.sid) {
      const sid = response.result.sid;
      sessionNotifyServiceSids.set(sessionId, sid);
      setNotifyServiceSid(sid);
      console.log('Created Notify Service:', sid);
      return sid;
    }

    console.error('Failed to create Notify Service: no SID in response');
    return null;
  } catch (error) {
    if (error instanceof ApiError) {
      console.error('API Error creating Notify Service:', error.statusCode, error.body);
    } else {
      console.error('Error creating Notify Service:', error);
    }
    return null;
  }
}

export async function createSmsBinding(
  bundle: TwilioClientBundle,
  sessionId: string,
  contactId: string,
  phoneE164: string
): Promise<boolean> {
  const serviceSid = await ensureNotifyService(bundle, sessionId);
  if (!serviceSid) {
    console.warn('Cannot create binding: service not available');
    return false;
  }

  try {
    const response = await bundle.bindingApi.createBinding(
      serviceSid,
      contactId, // identity
      BindingBindingTyp2.Sms,
      phoneE164, // address in E.164 format
      ['birthday'], // tags
      undefined, // notificationProtocolVersion
      undefined, // credentialSid
      undefined // endpoint
    );

    if (response.result && response.result.sid) {
      console.log(
        `Created SMS binding for ${phoneE164}: ${response.result.sid}`
      );
      return true;
    }
    return false;
  } catch (error) {
    if (error instanceof ApiError) {
      console.error('API Error creating binding:', error.statusCode, error.body);
    } else {
      console.error('Error creating binding:', error);
    }
    return false;
  }
}

export async function sendBirthdaySms(
  bundle: TwilioClientBundle | undefined,
  sessionId: string,
  contactId: string,
  phoneE164: string,
  messageBody: string
): Promise<SmsResult> {
  // If no client bundle, simulate sending
  if (!bundle) {
    console.log(`[SIMULATED] SMS to ${phoneE164}: ${messageBody}`);
    return {
      success: true,
      notificationSid: `SIM_${Date.now()}`,
    };
  }

  const serviceSid = await ensureNotifyService(bundle, sessionId);
  if (!serviceSid) {
    return { success: false, error: 'Notify service not available' };
  }

  try {
    const toBinding = [
      JSON.stringify({
        binding_type: 'sms',
        address: phoneE164,
      }),
    ];

    const response = await bundle.notificationApi.createNotification(
      serviceSid,
      messageBody,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined,
      toBinding, // toBinding
      undefined, undefined, undefined
    );

    if (response.result) {
      const notification = response.result;
      const sid =
        notification.sid !== undefined && notification.sid !== null
          ? notification.sid
          : undefined;
      console.log(`SMS sent to ${phoneE164}, SID: ${sid}`);
      return { success: true, notificationSid: sid ?? undefined };
    }

    return { success: false, error: 'No result in notification response' };
  } catch (error) {
    if (error instanceof ApiError) {
      const errorBody =
        typeof error.body === 'string' ? error.body : JSON.stringify(error.body);
      console.error(`API Error sending SMS to ${phoneE164}:`, error.statusCode, errorBody);

      if (error.statusCode === 400 || error.statusCode === 403) {
        return {
          success: false,
          error: `SMS failed (${error.statusCode}): This may be a trial account restriction. Ensure the recipient number is verified in your account. ${errorBody}`,
        };
      }
      return {
        success: false,
        error: `SMS API error (${error.statusCode}): ${errorBody}`,
      };
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Error sending SMS to ${phoneE164}:`, errMsg);
    return { success: false, error: errMsg };
  }
}

export function isTwilioConfigured(sessionId?: string): boolean {
  if (sessionId) {
    return activeClients.has(sessionId);
  }
  return activeClients.size > 0;
}
