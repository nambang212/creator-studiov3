// This file is a Vercel Serverless Function that acts as a secure backend.
// It receives requests from the frontend, adds the secret API key,
// calls the AI service, and then returns the result to the frontend.
// The file MUST be placed in a folder named "api".

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = require('node-fetch'); // For DALL-E calls

// IMPORTANT: In Vercel, you must set an Environment Variable named "GEMINI_API_KEY"
const geminiApiKey = process.env.GEMINI_API_KEY;
if (!geminiApiKey) {
    console.error("FATAL ERROR: GEMINI_API_KEY environment variable is not set.");
}
const genAI = new GoogleGenerativeAI(geminiApiKey);

const generateWithGemini = async (finalPrompt, imageParts) => {
    const systemInstruction = `You are an AI assistant specialized in creating photorealistic images. Your primary and only task is to generate a single image file based on the user's creative brief and reference images. Do not respond with text, code, or any other content besides the final image.`;
    
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash-image-preview",
        systemInstruction,
    });

    const content_parts = [];
    if (imageParts && imageParts.length > 0) {
        content_parts.push({ text: "Use the following uploaded image(s) as the primary visual reference for the subject. The text prompt that follows is the creative brief for the new scene you will create." }, ...imageParts);
    }
    content_parts.push({text: finalPrompt});

    let result;
    try {
        result = await model.generateContent({
            contents: [{ parts: content_parts }],
            generationConfig: {
                responseModalities: ['IMAGE']
            },
        });
    } catch (e) {
        console.error("CRITICAL CRASH inside generateContent (Gemini Image) call:", e);
        throw new Error(`Google AI SDK Error: ${e.message}`);
    }

    const response = await result.response;
    
    if (response.promptFeedback) {
        console.log("Safety Feedback from Gemini:", JSON.stringify(response.promptFeedback, null, 2));
    }

    const candidate = response.candidates?.[0];
    const base64ImageData = candidate?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
    
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
        console.error("Generation stopped for a reason other than STOP:", candidate.finishReason);
    }

    if (base64ImageData) {
        return `data:image/png;base64,${base64ImageData}`;
    } else {
        const textResponse = response.text();
        let finalError = "AI did not return an image.";
        if (textResponse) {
            finalError = `AI failed to create image, responding with text instead: "${textResponse}"`;
        }
        if (candidate?.finishReason === "SAFETY") {
             finalError += " This was likely due to the prompt or image triggering a safety filter.";
        }
        throw new Error(finalError);
    }
};


const generateWithDalle = async (finalPrompt, aspectRatio, openaiApiKey) => {
    const sizeMapping = { '1:1': '1024x1024', '9:16': '1024x1792', '16:9': '1792x1024', '4:5': '1024x1024' };
    const payload = { model: "dall-e-3", prompt: finalPrompt, n: 1, size: sizeMapping[aspectRatio] || '1024x1024', quality: "hd", style: "vivid" };

    const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST', OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    if (!geminiApiKey) {
        console.error("FATAL: GEMINI_API_KEY is not set on Vercel.");
        return res.status(500).json({ error: "Server configuration error: API Key is missing. Please check Vercel environment variables." });
    }

    try {
        const { type, payload } = req.body;
        console.log(`Handling request type: ${type}`);

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
                        default: creativeBrief += " Additional direction: Focus ONLY on the product packaging. Do not show the raw product separately."; break;
                    }
                }
            } else if (mode === 'Mockup Packaging') {
                creativeBrief = `Creative brief for a packaging mockup: Brand Name: "${brandName}". Design a '${mockupType}' packaging for this product based on the description: "${brandDescription}".`;
            } else { // Foto Produk
                creativeBrief = `Creative brief: "${prompt}".`;
                switch (aiFocus) {
                    case 'produk': creativeBrief += " Additional direction: Focus ONLY on the raw product or main subject, ignoring all packaging."; break;
                    case 'keduanya': creativeBrief += " CRITICAL direction: Display the product packaging AND the raw product together in a realistic, artistic scene."; break;
                    default: creativeBrief += " Additional direction: Focus ONLY on the product packaging. Do not show the raw product separately."; break;
                }
            }
            
            const finalPrompt = `Generate a single, photorealistic image with a ${descriptiveAspectRatio} aspect ratio, based on this creative brief: "${creativeBrief}". Your only output must be the image file.`;
            
            const imageParts = imageBlobs ? imageBlobs.map(blob => ({ inlineData: { mimeType: blob.mimeType, data: blob.data } })) : [];
            let imageUrl;
            if (engine === 'dalle') {
                if (!openaiApiKey) throw new Error("OpenAI API Key is required for DALL-E.");
                imageUrl = await generateWithDalle(finalPrompt, aspectRatio, openaiApiKey);
            } else {
                imageUrl = await generateWithGemini(finalPrompt, imageParts);
            }
            console.log("Image generation successful.");
            res.status(200).json({ imageUrl });

        } else if (type === 'final-render') {
            const { base64Data } = payload;
            const imagePart = { inlineData: { mimeType: 'image/png', data: base64Data } };
            const finalRenderPrompt = "Re-render this image from scratch as a final professional photograph. Enhance details, lighting, and textures to achieve hyper-realism...";
            const systemInstruction = "You are a specialist AI image final rendering engine...";
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest", systemInstruction });
            
            let result;
            try {
                result = await model.generateContent([finalRenderPrompt, imagePart]);
            } catch (e) {
                console.error("CRITICAL CRASH inside generateContent (Final Render) call:", e);
                throw new Error(`Google AI SDK Error: ${e.message}`);
            }

            const response = await result.response;
            const finalRenderBase64 = response.candidates[0].content.parts.find(p => p.inlineData)?.inlineData.data;
            if (finalRenderBase64) {
                console.log("Final render successful.");
                res.status(200).json({ imageUrl: `data:image/png;base64,${finalRenderBase64}` });
            } else {
                throw new Error("AI did not return a final render image.");
            }
            
        } else if (type === 'ideas') {
            const { modelPayload } = payload;
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

            let result;
            try {
                result = await model.generateContent(modelPayload);
            } catch (e) {
                console.error("CRITICAL CRASH inside generateContent (Ideas) call:", e);
                throw new Error(`Google AI SDK Error: ${e.message}`);
            }
            
            const response = await result.response;
            const ideasText = response.text();
            console.log("AI response for ideas (raw text):", ideasText);
            try {
                const parsedJson = JSON.parse(ideasText);
                console.log("Successfully parsed ideas JSON from AI.");
                res.status(200).json(parsedJson);
            } catch (parseError) {
                console.error("Failed to parse JSON from AI response:", parseError);
                throw new Error(`AI returned invalid JSON. Raw response: ${ideasText}`);
            }

        } else if (type === 'analyze') {
            const { imageParts, analysisType } = payload;
            let analysisPrompt, schema;

            if (analysisType === 'branding') {
                analysisPrompt = "You are an extremely precise Optical Character Recognition (OCR) agent... Your ONLY task is to identify and extract the most prominent text... Respond ONLY with a valid JSON object: `{\"brandName\": \"The Literal Brand Name\"}` or `{\"brandName\": null}`.";
                schema = { type: "OBJECT", properties: { brandName: { type: ["STRING", "NULL"] } }, required: ["brandName"] };
            } else { // content analysis
                analysisPrompt = "You are a visual product analyst. Your task is to classify the user's image... Respond ONLY with a valid JSON object with `hasPackaging` and `hasRawProduct` booleans...";
                schema = { type: "OBJECT", properties: { hasPackaging: { type: "BOOLEAN" }, hasRawProduct: { type: "BOOLEAN" } }, required: ["hasPackaging", "hasRawProduct"] };
            }
            
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
            
            let result;
            try {
                result = await model.generateContent({
                    contents: [{ parts: [{ text: analysisPrompt }, ...imageParts] }],
                    generationConfig: { responseMimeType: "application/json", responseSchema: schema }
                });
            } catch (e) {
                console.error("CRITICAL CRASH inside generateContent (Analyze) call:", e);
                throw new Error(`Google AI SDK Error: ${e.message}`);
            }

            const response = await result.response;
            const jsonText = response.text();
            console.log(`Analysis '${analysisType}' successful.`);
            res.status(200).json(JSON.parse(jsonText));

        } else {
            res.status(400).json({ error: 'Invalid request type' });
        }
    } catch (error) {
        console.error('Error in API function main handler:', error);
        res.status(500).json({ error: error.message || 'An unknown internal server error occurred.' });
    }
};

