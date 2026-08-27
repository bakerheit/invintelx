import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  registerInputSchema,
  setupStatusSchema,
  type RegisterInput,
  type SetupStatus,
} from '@invintelx/shared';
import { ApiError, apiRequest } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { FormField } from './FormField';
import { useAuth } from './AuthProvider';
import { AuthLayout } from './AuthLayout';

/** The form field names the server may attach an inline message to. */
const FORM_FIELDS = ['name', 'email', 'password', 'setupToken'] as const;

function isFormField(field: string): field is (typeof FORM_FIELDS)[number] {
  return (FORM_FIELDS as readonly string[]).includes(field);
}

export function RegisterPage() {
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  /*
   * Whether this instance still has to be claimed, and whether claiming it
   * needs the setup token. Unauthenticated, because nobody filling in this form
   * has an account yet.
   */
  const { data: setup, refetch: refetchSetup } = useQuery({
    queryKey: queryKeys.setupStatus,
    queryFn: () => apiRequest(setupStatusSchema, '/auth/setup'),
  });

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({ resolver: zodResolver(registerInputSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await registerUser(values);
      navigate('/items', { replace: true });
    } catch (error) {
      // The server sends field-keyed messages for things only it can know,
      // like an email already being taken. Show those on the field itself.
      if (error instanceof ApiError && error.fields) {
        let shown = false;
        for (const [field, message] of Object.entries(error.fields)) {
          // An inline message is only any use next to an input that is on
          // screen. The setup token field is not, until the status query says
          // this instance wants one — so that message falls through to the
          // form-level error instead of being attached to nothing.
          if (isFormField(field) && (field !== 'setupToken' || setup?.setupTokenRequired)) {
            setError(field, { message });
            shown = true;
          }
        }
        // A refusal is itself evidence the instance is unclaimed, so ask again:
        // it is what puts the field on screen for the retry.
        if (error.status === 403) void refetchSetup();
        if (shown) return;
      }
      setFormError(
        error instanceof ApiError ? error.message : 'Could not create the account. Try again.',
      );
    }
  });

  return (
    <AuthLayout title="Create your account" subtitle={subtitleFor(setup)}>
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <FormField
          label="Name"
          autoComplete="name"
          error={errors.name?.message}
          {...register('name')}
        />
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters."
          error={errors.password?.message}
          {...register('password')}
        />

        {setup?.setupTokenRequired && (
          <FormField
            label="Setup token"
            autoComplete="off"
            spellCheck={false}
            hint="Printed in the API's log when it started. Only the first account needs it."
            error={errors.setupToken?.message}
            {...register('setupToken')}
          />
        )}

        {formError && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError}
          </p>
        )}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account...' : 'Create account'}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

/**
 * Say what this particular registration actually does. "The first account is
 * the admin" was true on the hosted instance and alarming everywhere else; the
 * three cases are genuinely different and worth three sentences.
 */
export function subtitleFor(setup: SetupStatus | undefined): string | undefined {
  if (!setup) return undefined;
  if (setup.setupTokenRequired) {
    return 'This instance has no administrator yet. The setup token from the server log is what makes this account one.';
  }
  if (setup.firstAccount) {
    return 'This instance has no accounts, so this one becomes the administrator.';
  }
  return 'New accounts start as members.';
}
