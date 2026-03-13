require('dotenv').config();
const { Pool } = require('pg');

console.log('====================================');
console.log('Environment Variables Check:');
console.log('====================================');
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('DB_NAME:', process.env.DB_NAME);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '***SET***' : '***NOT SET***');
console.log('====================================\n');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'noirscreen_db',
});

async function test() {
  try {
    console.log('Attempting connection...\n');
    const result = await pool.query('SELECT NOW() as current_time, current_database() as db_name, current_user');
    console.log('✅ ✅ ✅ SUCCESS! Connected to PostgreSQL! ✅ ✅ ✅');
    console.log('Database:', result.rows[0].db_name);
    console.log('User:', result.rows[0].current_user);
    console.log('Time:', result.rows[0].current_time);
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.log('❌ ❌ ❌ CONNECTION FAILED! ❌ ❌ ❌');
    console.log('Error code:', error.code);
    console.log('Error message:', error.message);
    console.log('\nTrying to connect to:');
    console.log('Host:', process.env.DB_HOST || 'localhost');
    console.log('Port:', process.env.DB_PORT || 5432);
    console.log('Database:', process.env.DB_NAME || 'noirscreen_db');
    console.log('User:', process.env.DB_USER || 'postgres');
    await pool.end();
    process.exit(1);
  }
}

test();