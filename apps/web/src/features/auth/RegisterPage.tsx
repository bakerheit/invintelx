import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { registerInputSchema, type RegisterInput } from '@invintelx/shared';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { FormField } from './FormField';
import { useAuth } from './AuthProvider';
import { AuthLayout } from './AuthLayout';

export function RegisterPage() {
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

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
        for (const [field, message] of Object.entries(error.fields)) {
          if (field === 'email' || field === 'name' || field === 'password') {
            setError(field, { message });
          }
        }
        return;
      }
      setFormError(
        error instanceof ApiError ? error.message : 'Could not create the account. Try again.',
      );
    }
  });

  return (
    <AuthLayout title="Create your account" subtitle="The first account on an instance is the admin.">
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <FormField
          label="Name"
          autoComplete="name"
          autoFocus
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
