/**
 * Authentication routes.
 *   POST /auth/firebase   {idToken, name?, phone?}  Firebase ID token -> MediGuardian session (sign-up and sign-in, email or Google)
 *   POST /auth/refresh    {refreshToken}            rotate the session
 *   POST /auth/logout     {refreshToken}            end this session
 *   POST /auth/logout-all                           end every session (after a password change)
 *   GET/PATCH /auth/me                              profile (name, phone)
 *   DELETE /auth/account  {idToken}                 delete everything (needs a fresh Firebase sign-in)
 * Register / login / password reset forms talk to Firebase directly from the browser.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { z, validate } from '../lib/validate.js';
import { requireUser } from '../middleware/auth.js';
import * as auth from '../services/authService.js';

const ctx = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
const limiter = (limit, message) => rateLimit({
  windowMs: 15 * 60 * 1000, limit: config.isTest ? 100000 : limit, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'rate_limited', message } },
});
const signInLimit = limiter(40, 'Too many sign-in attempts from this network. Please wait 15 minutes and try again.');
const sensitiveLimit = limiter(10, 'Too many attempts. Please wait 15 minutes and try again.');

const idToken = z.string({ error: 'Sign-in token is missing.' }).min(100, 'Sign-in token is invalid.').max(5000, 'Sign-in token is invalid.');
const phone = z.string().trim().max(20, 'Phone number is too long.')
  .regex(/^\+?[0-9][0-9\s-]{5,18}$/, 'Phone number may contain only digits, spaces, dashes and a leading +.')
  .optional().nullable().or(z.literal(''));
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });

export const authRouter = Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

authRouter.post('/firebase', signInLimit, validate(z.object({
  idToken,
  name: z.string().trim().max(100, 'Name is too long (100 characters max).').optional(),
  phone,
})), h(async (req, res) => {
  const r = await auth.signInWithFirebase(req.body.idToken, { name: req.body.name, phone: req.body.phone || null }, ctx(req));
  res.status(r.isNewUser ? 201 : 200).json(r);
}));

authRouter.post('/refresh', validate(refreshBody), h(async (req, res) => res.json(await auth.refreshSession(req.body.refreshToken, ctx(req)))));
authRouter.post('/logout', validate(refreshBody), h(async (req, res) => { await auth.logoutSession(req.body.refreshToken); res.json({ ok: true }); }));
authRouter.post('/logout-all', requireUser, h(async (req, res) => { await auth.logoutEverywhere(req.user.id, ctx(req)); res.json({ ok: true }); }));

authRouter.get('/me', requireUser, (req, res) => res.json({ user: req.user }));
authRouter.patch('/me', requireUser, validate(z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').max(100, 'Name is too long (100 characters max).').optional(),
  phone,
})), h(async (req, res) => res.json({ user: await auth.updateProfile(req.user.id, req.body) })));

authRouter.delete('/account', requireUser, sensitiveLimit, validate(z.object({ idToken })),
  h(async (req, res) => res.json(await auth.deleteAccount(req.user.id, req.body.idToken, ctx(req)))));
