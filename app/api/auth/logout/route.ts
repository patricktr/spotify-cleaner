import { NextRequest, NextResponse } from 'next/server';

const COOKIE_NAME = 'admin_session';

function buildResponse(req: NextRequest) {
  const response = NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}

export async function POST(req: NextRequest) {
  return buildResponse(req);
}

export async function GET(req: NextRequest) {
  return buildResponse(req);
}
