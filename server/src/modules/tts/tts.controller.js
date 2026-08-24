import * as ttsService from './tts.service.js';

export async function generate(req, res) {
  const { generation, credits } = await ttsService.generate({
    user: req.user,
    text: req.body.text,
    voiceId: req.body.voiceId,
    idempotencyKey: req.body.idempotencyKey ?? null,
  });

  res.status(201).json({
    success: true,
    data: {
      generation: generation.toPublicJSON(),
      // Returned so the balance widget updates from the same response that spent
      // the credits, instead of going stale until the next page load.
      credits,
    },
  });
}

export async function getAudio(req, res) {
  const { buffer, mimeType, filename } = await ttsService.getAudio({
    userId: req.user._id,
    generationId: req.params.id,
  });

  res.set({
    'Content-Type': mimeType,
    'Content-Length': buffer.byteLength,
    // inline so opening the URL directly plays it; the download button uses the
    // anchor's `download` attribute rather than relying on this.
    'Content-Disposition': `inline; filename="${filename}"`,
    // Per-user audio behind a bearer token has no business in a shared cache.
    'Cache-Control': 'private, no-store',
  });

  res.send(buffer);
}

export async function getConfig(req, res) {
  const config = await ttsService.getConfig(req.user);

  res.status(200).json({ success: true, data: { config } });
}
