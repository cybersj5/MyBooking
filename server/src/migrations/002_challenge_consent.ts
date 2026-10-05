export const challengeConsentMigration = `
ALTER TABLE email_challenges ADD COLUMN consentVersion TEXT;
ALTER TABLE email_challenges ADD COLUMN consentAcceptedAt INTEGER;
`;
