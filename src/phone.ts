/**
 * Phone number validation and E.164 formatting.
 * Handles international numbers with country codes.
 */

// Common country calling codes for reference
const COUNTRY_CODES: Record<string, string> = {
  '1': 'US/CA',
  '44': 'UK',
  '91': 'IN',
  '61': 'AU',
  '33': 'FR',
  '49': 'DE',
  '81': 'JP',
  '86': 'CN',
  '55': 'BR',
  '52': 'MX',
  '34': 'ES',
  '39': 'IT',
  '82': 'KR',
  '31': 'NL',
  '46': 'SE',
  '47': 'NO',
  '45': 'DK',
  '358': 'FI',
  '48': 'PL',
  '41': 'CH',
  '43': 'AT',
  '32': 'BE',
  '351': 'PT',
  '353': 'IE',
  '64': 'NZ',
  '65': 'SG',
  '60': 'MY',
  '66': 'TH',
  '63': 'PH',
  '62': 'ID',
  '84': 'VN',
  '90': 'TR',
  '966': 'SA',
  '971': 'AE',
  '972': 'IL',
  '20': 'EG',
  '27': 'ZA',
  '234': 'NG',
  '254': 'KE',
  '92': 'PK',
  '880': 'BD',
};

export interface PhoneValidationResult {
  valid: boolean;
  formatted?: string; // E.164 format
  error?: string;
  countryHint?: string;
}

export function validateAndFormatPhone(input: string): PhoneValidationResult {
  // Strip all non-digit characters except leading +
  let cleaned = input.trim();
  const hasPlus = cleaned.startsWith('+');
  cleaned = cleaned.replace(/[^\d]/g, '');

  if (cleaned.length === 0) {
    return { valid: false, error: 'Phone number is empty' };
  }

  // If it started with +, we already have the full international number
  if (hasPlus) {
    if (cleaned.length < 7 || cleaned.length > 15) {
      return {
        valid: false,
        error: `Phone number with country code should be 7-15 digits, got ${cleaned.length}`,
      };
    }
    const formatted = `+${cleaned}`;
    const countryHint = detectCountry(cleaned);
    return { valid: true, formatted, countryHint };
  }

  // If starts with 00 (international dialing prefix), treat the rest as country code + number
  if (cleaned.startsWith('00')) {
    cleaned = cleaned.substring(2);
    if (cleaned.length < 7 || cleaned.length > 15) {
      return {
        valid: false,
        error: `Phone number should be 7-15 digits after country code, got ${cleaned.length}`,
      };
    }
    const formatted = `+${cleaned}`;
    const countryHint = detectCountry(cleaned);
    return { valid: true, formatted, countryHint };
  }

  // If 10 digits (no country code), assume US/Canada (+1)
  if (cleaned.length === 10) {
    const formatted = `+1${cleaned}`;
    return { valid: true, formatted, countryHint: 'US/CA (assumed)' };
  }

  // If 11 digits starting with 1, assume US/Canada
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    const formatted = `+${cleaned}`;
    return { valid: true, formatted, countryHint: 'US/CA' };
  }

  // Try to treat it as a full international number
  if (cleaned.length >= 7 && cleaned.length <= 15) {
    const formatted = `+${cleaned}`;
    const countryHint = detectCountry(cleaned);
    if (countryHint) {
      return { valid: true, formatted, countryHint };
    }
    return {
      valid: false,
      error:
        'Could not determine country code. Please include "+" followed by your country code (e.g., +44 for UK, +1 for US).',
    };
  }

  return {
    valid: false,
    error: `Invalid phone number length (${cleaned.length} digits). Expected 7-15 digits with country code.`,
  };
}

function detectCountry(digits: string): string | undefined {
  // Check 3-digit codes first, then 2-digit, then 1-digit
  for (const len of [3, 2, 1]) {
    const prefix = digits.substring(0, len);
    if (COUNTRY_CODES[prefix]) {
      return COUNTRY_CODES[prefix];
    }
  }
  return undefined;
}

export function isE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}
