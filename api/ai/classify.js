module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    let lower = message.toLowerCase().trim();
    lower = lower.replace(/what'?s/g, 'what is')
                 .replace(/infront/g, 'in front')
                 .replace(/surounding/g, 'surrounding');

    // 1. Navigation intent
    const navPatterns = [
      'guide me to', 'navigate to', 'take me to', 'go to', 'head to',
      'directions to', 'route to', 'lead me to', 'walk me to', 'bring me to',
      'where is', 'how to reach', 'nearest', 'closest', 'nearby', 'find way to'
    ];

    for (const phrase of navPatterns) {
      if (lower.includes(phrase)) {
        // Simple extraction: get text after the phrase
        const idx = lower.indexOf(phrase) + phrase.length;
        const destination = lower.substring(idx).replace(/[?.!,;]+$/, '').trim();
        return res.status(200).json({
          intent: 'NAVIGATION',
          destination: destination || null
        });
      }
    }

    // Keyword fallback for navigation
    const navKeywords = [
      'hospital', 'school', 'pharmacy', 'market', 'station',
      'airport', 'bus stop', 'temple', 'mosque', 'church', 'mall', 'park',
      'restaurant', 'cafe', 'shop', 'police', 'bank'
    ];
    for (const kw of navKeywords) {
      if (lower.includes(kw)) {
        return res.status(200).json({
          intent: 'NAVIGATION', 
          destination: kw
        });
      }
    }

    // 2. Vision intent
    const visionPatterns = [
      'what is in front', 'what do i see', 'what am i looking at', 'describe',
      'what color', 'what colour', 'read the', 'read this', 'detect', 'scan',
      'see', 'look at', 'camera', 'vision', 'obstacle', 'person', 'sign'
    ];

    for (const phrase of visionPatterns) {
      if (lower.includes(phrase)) {
        return res.status(200).json({
          intent: 'VISION',
          destination: null
        });
      }
    }

    // 3. General chat
    return res.status(200).json({
      intent: 'GENERAL_CHAT',
      destination: null
    });

  } catch (error) {
    console.error('Classification error:', error);
    // Always fallback to GENERAL_CHAT on error instead of throwing a 500
    return res.status(200).json({
      intent: 'GENERAL_CHAT',
      destination: null
    });
  }
}
