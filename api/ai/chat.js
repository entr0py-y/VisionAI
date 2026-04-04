import { safeInsert } from '../../lib/supabaseClient.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { message, history, systemPrompt, username } = await req.json();

    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const VISION_PERSONA = `You are Vision, a warm and deeply aware AI assistant built into a wearable 
device for visually impaired users. You speak directly into the user's ear 
in real time — every word you say gets read aloud to them. No screens. No 
hands. Just your voice.

## HOW TO TALK

Warm, calm, and human. Like a trusted friend who happens to have superpowers.

- Use contractions: "there's", "you're", "it's", "don't", "I'm"
- Short answers unless detail genuinely needed
- Never start with "Certainly!", "Of course!", "Great question!"
- Never say "As an AI" or refer to yourself as a model or system
- If something could be dangerous, say so — gently but clearly
- If unsure, say so honestly rather than guessing
- Speak in the user's language if detectable
`;

    const fullSystemPrompt = systemPrompt || VISION_PERSONA;

    // Build the prompt for Gemini (flatten system + history + user message)
    let promptParts = [];
    promptParts.push(fullSystemPrompt);

    if (history && Array.isArray(history)) {
      for (const entry of history) {
        const role = entry.role === 'user' ? 'USER' : 'ASSISTANT';
        promptParts.push(`${role}: ${entry.text || ''}`);
      }
    }

    promptParts.push(`USER: ${message}`);
    promptParts.push('ASSISTANT:');

    const finalPrompt = promptParts.join('\n\n');

    // Store user message (fire and forget)
    try {
      safeInsert('messages', { role: 'user', content: message, type: 'chat', username: username || 'unknown' }).catch(() => {});
    } catch(e) {}

    // Use Gemini API key
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error('Missing GEMINI_API_KEY environment variable');
      return new Response(JSON.stringify({
        error: 'Configuration Error',
        fallback: 'System missing GEMINI_API_KEY. Please check deployment settings or switch to Offline Mode.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Use Gemini REST API with streaming
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: finalPrompt }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API Error:', response.status, errText);
      return new Response(JSON.stringify({
        error: 'Gemini API Error',
        fallback: response.status === 429 
          ? "I'm receiving too many requests right now. Please wait a moment."
          : `I'm having trouble connecting to Gemini. Status: ${response.status}. ${errText.substring(0, 200)}`
      }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Transform Gemini SSE stream into plain text chunks for the frontend
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    let buffer = '';
    let fullAssistantResponse = '';
    const transformStream = new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.replace('data: ', '').trim();
            if (dataStr === '[DONE]') continue;
            try {
              const data = JSON.parse(dataStr);
              // Gemini SSE format: candidates[0].content.parts[0].text
              const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (content) {
                fullAssistantResponse += content;
                controller.enqueue(encoder.encode(content));
              }
            } catch (e) {
              // Ignore invalid JSON or incomplete chunks
            }
          }
        }
      },
      flush(controller) {
        // Store assistant response
        try {
          safeInsert('messages', { role: 'assistant', content: fullAssistantResponse, type: 'chat', username: username || 'unknown' }).catch(() => {});
        } catch(e) {}
      }
    });

    return new Response(response.body.pipeThrough(transformStream), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Content-Type-Options': 'nosniff',
      },
    });

  } catch (error) {
    console.error('Edge Function Error:', error);
    return new Response(JSON.stringify({
      error: 'Failed to process AI chat request',
      fallback: "I encountered an error while processing your request. Please try again."
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
