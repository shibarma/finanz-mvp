import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { refreshPricesEngine } from '../../../../lib/refreshPricesEngine';

function createRouteSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Supabase route client is not configured. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');

    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing or invalid Authorization header',
        },
        { status: 401 },
      );
    }

    const accessToken = authHeader.slice('bearer '.length).trim();
    if (!accessToken) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Access token is empty',
        },
        { status: 401 },
      );
    }

    const supabase = createRouteSupabaseClient();
    const { data, error } = await supabase.auth.getUser(accessToken);

    if (error || !data?.user) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Unauthorized: failed to resolve Supabase user',
          details: error?.message,
        },
        { status: 401 },
      );
    }

    const userId = data.user.id;

    const summary = await refreshPricesEngine({ userId, force: true });

    return NextResponse.json({
      ok: summary.ok,
      processed: summary.processed,
      updated: summary.updated,
      skipped: summary.skipped,
      fxUpdated: summary.fxUpdated,
      fxSkipped: summary.fxSkipped,
      errors: summary.errors,
      errors_count: summary.errors.length,
    });
  } catch (error) {
    console.error('Error in manual refresh-prices route:', error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 },
    );
  }
}

