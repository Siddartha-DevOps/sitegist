type UnknownRecord = Record<string, any>;

function pick(source: UnknownRecord, keys: string[]): UnknownRecord {
  const result: UnknownRecord = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export function toPublicWidgetSettings(settings: unknown): UnknownRecord {
  const source = settings && typeof settings === "object" ? (settings as UnknownRecord) : {};
  const branding = source.branding && typeof source.branding === "object" ? source.branding : {};
  return {
    branding: pick(branding, [
      "primaryColor",
      "assistantName",
      "assistantLogo",
      "greetingMessage",
      "suggestions",
      "bubbleShape",
      "font",
      "leadPolicy",
      "proactive",
      "removeBranding",
    ]),
    leadFields: Array.isArray(source.leadFields) ? source.leadFields : [],
    businessHours: source.businessHours && typeof source.businessHours === "object" ? source.businessHours : undefined,
  };
}
