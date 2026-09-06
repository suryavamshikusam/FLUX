import { VercelRequest, VercelResponse } from '@vercel/node';
import Pusher from 'pusher';
import md5 from 'md5';

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '',
  key: process.env.VITE_PUSHER_APP_KEY || '',
  secret: process.env.PUSHER_APP_SECRET || '',
  cluster: process.env.VITE_PUSHER_CLUSTER || 'us2',
  useTLS: true,
});

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') {
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
    const ipStr = Array.isArray(ip) ? ip[0] : ip;
    const realIp = ipStr.split(',')[0].trim();
    const networkHash = md5(realIp).substring(0, 10);
    return res.status(200).json({ channel_name: `presence-net-${networkHash}` });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Check if credentials exist
  if (!process.env.PUSHER_APP_ID) {
    return res.status(500).json({ error: 'Pusher credentials not configured.' });
  }

  // Express urlencoded body parser is typically used by Pusher clients.
  // Vercel parses this automatically into req.body for application/json or x-www-form-urlencoded
  const socket_id = req.body.socket_id;
  const channel_name = req.body.channel_name;

  if (!socket_id || !channel_name) {
    return res.status(400).json({ error: 'Missing socket_id or channel_name' });
  }

  // Generate a random ID and alias for this user
  const userId = Math.random().toString(36).substring(2, 10);
  const userAgent = req.headers['user-agent'] || '';
  const deviceType = /Mobile|Android|iP(hone|od|ad)/.test(userAgent) ? 'Smartphone' : 'Laptop';
  
  // Extract IP
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';
  const ipStr = Array.isArray(ip) ? ip[0] : ip;
  // If you are behind a proxy, it might be a comma-separated list. We take the first one.
  const realIp = ipStr.split(',')[0].trim();
  
  const networkHash = md5(realIp).substring(0, 10);
  const expectedChannel = `presence-net-${networkHash}`;
  
  // Strict enforcement
  if (process.env.NODE_ENV === 'production' && channel_name !== expectedChannel) {
    return res.status(403).json({ error: 'Unauthorized network' });
  }

  const presenceData = {
    user_id: userId,
    user_info: {
      deviceType,
      joinedAt: Date.now(),
    },
  };

  try {
    const authResponse = pusher.authorizeChannel(socket_id, channel_name, presenceData);
    res.status(200).json(authResponse);
  } catch (error) {
    console.error('Pusher auth error:', error);
    res.status(500).json({ error: 'Failed to authenticate' });
  }
}
