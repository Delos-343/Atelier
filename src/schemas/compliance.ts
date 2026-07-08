import { z } from 'zod';

/**
 * Update one raw material's halal record. A certified material must carry a
 * certificate number and an expiry date (the DB CHECK is the backstop). Cert
 * strings are trimmed; empty/absent optional fields are coalesced to null by
 * the server before the write.
 */
export const updateMaterialHalalSchema = z
  .object({
    materialId: z.string().uuid('A valid material id is required.'),
    halalStatus: z.enum(['certified', 'not_certified', 'in_review'], {
      errorMap: () => ({ message: 'Status must be certified, not_certified, or in_review.' }),
    }),
    halalCertNumber: z.string().trim().max(120, 'Certificate number is too long.').nullish(),
    halalCertifier: z.string().trim().max(120, 'Certifier name is too long.').nullish(),
    halalCertExpiry: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry must be a date (YYYY-MM-DD).')
      .nullish(),
  })
  .refine(
    (v) =>
      v.halalStatus !== 'certified' ||
      (v.halalCertNumber != null && v.halalCertNumber !== '' && v.halalCertExpiry != null),
    {
      message: 'A certified material needs a certificate number and an expiry date.',
      path: ['halalCertNumber'],
    },
  );

export type UpdateMaterialHalalDTO = z.infer<typeof updateMaterialHalalSchema>;
