// This file is a Vercel Serverless Function that acts as a secure backend.
// It receives requests from the frontend, adds the secret API key,
// calls the AI service, and then returns the result to the frontend.
// The file MUST be placed in a folder named "api".

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch'); // For DALL-E calls

// IMPORTANT: In Vercel, you must set an Environment Variable named "GEMINI_API_KEY"
const geminiApiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Helper to convert data URI to a blob-like object for Google's API
function dataUriToGoogleGenerativePart(uri) {
    const [header, data] = uri.split(',');
    const mimeType = header.match(/:(.*?);/)[1];
    return {
        inlineData: {
            data,
            mimeType,
        },
    };
}


const generateWithGemini = async (finalPrompt, imageParts) => {
    const systemInstruction = `You are a world-class commercial photographer and design AI. Your primary directive is to follow the user's creative brief with extreme precision, especially regarding aspect ratio, subject focus, and style.

**Core Rules:**
1.  **Aspect Ratio is LAW:** The final image's aspect ratio MUST strictly match the one specified in the prompt (e.g., 'square (1:1)', 'widescreen landscape (16:9)'). This is non-negotiable.
2.  **Subject Focus is CRITICAL:** Adhere strictly to the focus direction ('kemasan' for packaging, 'produk' for raw product, 'keduanya' for both).
    * 'kemasan': The packaging is the hero. The raw product should NOT be visible.
    * 'produk': The raw product is the hero. The packaging should NOT be visible.
    * 'keduanya': Both packaging and raw product must be present and artistically integrated.
3.  **Literal Interpretation:** Interpret the user's prompt as literally as possible. If they ask for 'dramatic lighting on a marble surface', deliver exactly that. Avoid overly artistic interpretations that deviate from the core request.
4.  **No Text (Unless Specified):** Do NOT add any text, logos, or watermarks to the image unless explicitly requested in the prompt (e.g., a poster headline). For product photos, the image should be clean.
5.  **Hyper-realism:** Generate images with photorealistic quality, paying close attention to textures, shadows, and reflections. The output should look like a high-budget professional photograph or a high-quality CGI render.
6.  **Contextual Backgrounds:** Create backgrounds that complement the product and brief. If the brief is 'minimalist', the background should be simple and clean. If 'luxurious', it should be elegant.
7.  **Indonesian Context:** Understand that prompts may have an Indonesian context. Interpret brand names, product types, and styles accordingly.

**Output Format:**
* You MUST respond with only the generated image in the requested format. Do not add any conversational text, descriptions, or apologies. Your entire response is the image itself.`;
    
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash-latest",
        systemInstruction,
    });

    const result = await model.generateContent([finalPrompt, ...imageParts]);
    const response = await result.response;
    const base64ImageData = response.candidates[0].content.parts.find(p => p.inlineData)?.inlineData.data;

    if (base64ImageData) {
        return `data:image/png;base64,${base64ImageData}`;
    } else {
        const textResponse = response.text();
        const finalError = textResponse ? `AI failed to create image: "${textResponse}"` : "AI did not return an image. This might be due to safety filters or an incompatible prompt.";
        throw new Error(finalError);
    }
};

const generateWithDalle = async (finalPrompt, aspectRatio, openaiApiKey) => {
    const sizeMapping = { '1:1': '1024x1024', '9:16': '1024x1792', '16:9': '1792x1024', '4:5': '1024x1024' }; // 4:5 is not native, will be cropped by user or displayed letterboxed
    const payload = {
        model: "dall-e-3",
        prompt: finalPrompt,
        n: 1,
        size: sizeMapping[aspectRatio] || '1024x1024',
        quality: "hd",
        style: "vivid"
    };

    const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`OpenAI Error: ${errorData.error.message}`);
    }

    const result = await response.json();
    if (result.data && result.data[0].url) {
        return result.data[0].url;
    } else {
        throw new Error("DALL-E did not return an image.");
    }
};

// Main handler for all incoming requests
module.exports = async (req, res) => {
    // Set CORS headers to allow requests from any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle OPTIONS preflight request for CORS
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { type, payload } = req.body;

        if (type === 'image') {
            const { mode, prompt, posterHeadline, mockupType, brandName, brandDescription, aspectRatio, aiFocus, engine, openaiApiKey, imageBlobs } = payload;
            
            const aspectRatioDescriptions = { '1:1': 'square (1:1)', '4:5': 'portrait (4:5)', '9:16': 'tall portrait (9:16)', '16:9': 'widescreen landscape (16:9)' };
            const descriptiveAspectRatio = aspectRatioDescriptions[aspectRatio];

            let creativeBrief = "";
            if (mode === 'Poster / Desain') {
                creativeBrief = `Creative brief for a poster: "${prompt}". Headline Text: "${posterHeadline}".`;
                if (imageBlobs && imageBlobs.length > 0) {
                    switch (aiFocus) {
                        case 'produk': creativeBrief += " Additional direction: Focus ONLY on the raw product or main subject, ignoring all packaging."; break;
                        case 'keduanya': creativeBrief += " CRITICAL direction: Display the product packaging AND the raw product together in a realistic, artistic scene."; break;
                        case 'kemasan': default: creativeBrief += " Additional direction: Focus ONLY on the product packaging. Do not show the raw product separately."; break;
                    }
                }
            } else if (mode === 'Mockup Packaging') {
                creativeBrief = `Creative brief for a packaging mockup: Brand Name: "${brandName}". Design a '${mockupType}' packaging for this product based on the description: "${brandDescription}".`;
            } else { // Foto Produk
                creativeBrief = `Creative brief: "${prompt}".`;
                switch (aiFocus) {
                    case 'produk': creativeBrief += " Additional direction: Focus ONLY on the raw product or main subject, ignoring all packaging."; break;
                    case 'keduanya': creativeBrief += " CRITICAL direction: Display the product packaging AND the raw product together in a realistic, artistic scene."; break;
                    case 'kemasan': default: creativeBrief += " Additional direction: Focus ONLY on the product packaging. Do not show the raw product separately."; break;
                }
            }
            const finalPrompt = `**[LAW 1: ASPECT RATIO] The final image MUST BE ${descriptiveAspectRatio}.**\n\n${creativeBrief}`;
            
            const imageParts = imageBlobs ? imageBlobs.map(blob => ({ inlineData: { mimeType: blob.mimeType, data: blob.data } })) : [];
            
            let imageUrl;
            if (engine === 'dalle') {
                if (!openaiApiKey) throw new Error("OpenAI API Key is required for DALL-E.");
                imageUrl = await generateWithDalle(finalPrompt, aspectRatio, openaiApiKey);
            } else {
                if (!geminiApiKey) throw new Error("Gemini API Key is not configured on the server.");
                imageUrl = await generateWithGemini(finalPrompt, imageParts);
            }
            
            res.status(200).json({ imageUrl });

        } else if (type === 'final-render') {
            const { base64Data } = payload;
            const imagePart = { inlineData: { mimeType: 'image/png', data: base64Data } };
            const finalRenderPrompt = "Re-render this image from scratch as a final professional photograph. Enhance details, lighting, and textures to achieve hyper-realism. Do not change the subject, composition, or aspect ratio. Your task is purely technical enhancement to the highest possible quality.";
            const systemInstruction = "You are a specialist AI image final rendering engine. Your only job is to take an existing image and upscale its quality to the maximum possible level, focusing on realism, detail, and professional finish. You must not alter the creative content.";

            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest", systemInstruction });
            const result = await model.generateContent([finalRenderPrompt, imagePart]);
            const response = await result.response;
            const finalRenderBase64 = response.candidates[0].content.parts.find(p => p.inlineData)?.inlineData.data;

            if (finalRenderBase64) {
                const imageUrl = `data:image/png;base64,${finalRenderBase64}`;
                res.status(200).json({ imageUrl });
            } else {
                throw new Error("AI did not return a final render image.");
            }
            
        } else if (type === 'ideas') {
            const { payload: ideaPayload } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
            const result = await model.generateContent({
                ...ideaPayload,
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: ideaPayload.generationConfig.responseSchema,
                },
            });
            const response = await result.response;
            const ideasText = response.text();
            res.status(200).json(JSON.parse(ideasText));
        } else {
            res.status(400).json({ error: 'Invalid request type' });
        }
    } catch (error) {
        console.error('Error in API function:', error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
};

