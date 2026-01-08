import Database from 'better-sqlite3';
import { join } from 'path';

const db = new Database(join(process.cwd(), 'seed', 'grantflow.db'));

try {
    const adminEmail = 'buckeye7066@gmail.com';
    const admin = db.prepare('SELECT id FROM users WHERE LOWER(primary_email) = ?').get(adminEmail.toLowerCase());
    
    if (!admin) {
        console.error('Admin user not found');
        process.exit(1);
    }
    
    console.log(`Linking all profiles to admin ${admin.id} (${adminEmail})`);
    
    const result = db.prepare(`
        UPDATE profiles 
        SET user_id = ?, updated_at = CURRENT_TIMESTAMP
    `).run(admin.id);
    
    console.log(`Updated ${result.changes} profiles`);
    
    // Also ensure all organizations are linked to this admin if needed
    // (Organizations table doesn't have user_id, it's linked via profile)
    
} catch (error) {
    console.error('Error fixing profiles:', error);
} finally {
    db.close();
}
