// Миграция 003: сохраняем email в guest_access, чтобы по токену доступа
// можно было проверить, что вызов делает именно гость этой заявки, а не
// обладатель чужого токена, выписанного на ту же заявку (PDR §10.1 AUTH-14/15).
export const guestAccessEmailMigration = `
ALTER TABLE guest_access ADD COLUMN email TEXT NOT NULL DEFAULT '';
`;
