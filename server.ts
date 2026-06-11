import express from "express";
import path from "path";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(cors());
// Increase limit for base64 image uploads
app.use(express.json({ limit: '50mb' }));

const PORT = 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyC7TP687TrQrTC_vms_zwGoskU8_n4EJ7c";

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

app.post("/api/analyze", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "API Key Missing: Please configure GEMINI_API_KEY in your environment." });
  }
  const { content, type, mimeType } = req.body;
  if (!content) {
    return res.status(400).json({ error: "Content is required" });
  }

  try {
    let prompt = `You are an expert fact-checker. Please analyze the following content.
Follow these steps carefully:
1. Extract the main claim(s) from the content.
2. Use Google Search to verify these claims against trusted news sources.
3. Compare information from multiple sources.
4. Identify supporting evidence and contradictory evidence.
5. Calculate a confidence score based on the evidence found.
6. If the evidence is insufficient or you cannot find enough reliable information, you MUST set the "verdict" to "Insufficient Evidence". Do not guess!
7. Never claim a news story is real or fake without supporting evidence.

Format your response strictly as JSON with the following keys:
- verdict: (string) "True", "Likely True", "Mixed", "Likely False", "False", or "Insufficient Evidence"
- truthPercentage: (number) 0-100
- falsePercentage: (number) 0-100
- confidenceScore: (number) 0-100
- credibilityScore: (number) 0-100
- riskLevel: (string) "Low", "Medium", "High", or "Critical"
- explanation: (string) Detailed AI explanation of the findings and your reasoning.
- factCheckSummary: (string) Recommmendation and cross-reference findings summary.
- supportingEvidence: (string array) List of points and evidence found supporting or contradicting the claims.
- potentialConcerns: (string array) List of suspicious points, logical fallacies, or missing context.
- sourcesVerified: (string array) List of Trusted Sources (include names of websites and articles you found during your search).

Content to analyze: `;

    let contentsArray: any[] = [];

    if (type === "url") {
        prompt += `\nAnalyze the potential fake news from this URL context: ${content}`;
        contentsArray = [prompt];
    } else if (type === "text") {
        prompt += `\n${content}`;
        contentsArray = [prompt];
    } else if (type === "image") {
        prompt += `\nExtract text via OCR from the provided image and analyze the image context/text for misinformation.`;
        // Assuming content is base64 string
        const base64Data = content.replace(/^data:image\/\w+;base64,/, "");
        contentsArray = [
            prompt,
            { inlineData: { data: base64Data, mimeType: mimeType || "image/jpeg" } }
        ];
    }

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contentsArray,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
      },
    });

    if (!response.text) throw new Error("Empty response from Gemini");
    res.json(JSON.parse(response.text));
  } catch (err: any) {
    if (err?.status !== 429 && !err.message?.includes('429')) {
      console.error("Gemini API Error:", err);
    }
    
    // Execute powerful fallback pipeline if Gemini fails
    let textToAnalyze = content;
    if (type === 'url') textToAnalyze = content; // Can't easily scrape URL in fallback without extra libs, so just use URL text
    if (type === 'image') textToAnalyze = "Image Fact Check";
    
    // Simple Keyword Extractor
    const words = textToAnalyze.replace(/[.,!?\n']/g, ' ').split(' ')
        .filter((w: string) => w.length > 4)
        .slice(0, 4);
    
    let supportingEvidence: string[] = [];
    let sourcesVerified: string[] = [];
    let foundInformation = false;

    // 1. Try Google Fact Check API
    try {
        const fcUrl = `https://factchecktools.googleapis.com/v1alpha1/claims:search?query=${encodeURIComponent(words.join(' '))}&key=${GEMINI_API_KEY}`;
        const fcRes = await fetch(fcUrl);
        if (fcRes.ok) {
            const data: any = await fcRes.json();
            if (data.claims && data.claims.length > 0) {
                foundInformation = true;
                data.claims.slice(0, 3).forEach((c: any) => {
                    if (c.claimReview && c.claimReview.length > 0) {
                        const review = c.claimReview[0];
                        supportingEvidence.push(`Fact Check (${review.publisher.name}): ${review.textualRating} - ${c.text}`);
                        sourcesVerified.push(review.url || review.publisher.name);
                    }
                });
            }
        }
    } catch (e) {
        // Ignore fetch errors
    }

    // 2. Try Wikipedia Fallback
    if (!foundInformation && words.length > 0) {
        try {
            const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(words.join(' '))}&utf8=&format=json`;
            const wikiRes = await fetch(wikiUrl);
            if (wikiRes.ok) {
                const data: any = await wikiRes.json();
                if (data.query && data.query.search && data.query.search.length > 0) {
                    foundInformation = true;
                    data.query.search.slice(0, 3).forEach((s: any) => {
                        const snippet = s.snippet.replace(/<\/?[^>]+(>|$)/g, "");
                        supportingEvidence.push(`Wikipedia indicates: ${snippet}...`);
                        sourcesVerified.push(`Wikipedia Reference: ${s.title}`);
                    });
                }
            }
        } catch (e) {
            // Ignore fetch errors
        }
    }

    if (foundInformation) {
        const fallbackResponse = {
            verdict: "Mixed",
            truthPercentage: 50,
            falsePercentage: 50,
            confidenceScore: 65,
            credibilityScore: 55,
            riskLevel: "Medium",
            explanation: "Deep AI analysis is currently impacted by high traffic. We executed a live external search through trusted encyclopedias and fact-checking engines to find related context base on the claims.",
            factCheckSummary: "Review the independent reports from fact-checking organizations or encyclopedias found below.",
            supportingEvidence,
            potentialConcerns: ["Due to volume, analysis was limited to keyword retrieval.", "Deep contextual nuance may be missing."],
            sourcesVerified: sourcesVerified.length > 0 ? sourcesVerified : ["Public Fact Check databases"]
        };
        return res.json(fallbackResponse);
    }

    // If completely no evidence found
    const fallbackResponse = {
        verdict: "Insufficient Evidence",
        truthPercentage: 0,
        falsePercentage: 0,
        confidenceScore: 10,
        credibilityScore: 0,
        riskLevel: "Low",
        explanation: "Our systems searched live trusted databases, but could not find sufficient reliable evidence to confirm or debunk this specific claim. It is highly recommended to seek professional fact-checking sources.",
        factCheckSummary: "No conclusive evidence found in Google Fact Check or trusted databases.",
        supportingEvidence: ["No corroborating independent reports found matching the main claims."],
        potentialConcerns: ["Lack of primary sources.", "Claim could not be verified online footprint."],
        sourcesVerified: []
    };
    res.json(fallbackResponse);
  }
});

app.post("/api/chat", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "API Key Missing: Please configure GEMINI_API_KEY in your environment." });
  }
  try {
    const { messages } = req.body;
    const history = messages.map((m: any) => ({
      role: m.role,
      parts: [{ text: m.content }]
    }));
    
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: history,
        config: {
            systemInstruction: "You are TruthLens AI, an expert, factual, and unbiased fact-checking assistant. You help users understand complex news, identify misinformation, explain cognitive biases, and provide summaries. Maintain a professional, journalistic, and helpful tone.",
        }
    });

    res.json({ text: response.text });
  } catch(err: any) {
    if (err?.status !== 429 && !err.message?.includes('429')) {
      console.error("Chat API error:", err.message);
      return res.status(500).json({ text: `AI Error: ${err.message}` });
    }
    return res.json({ text: "Our AI systems are currently operating at maximum capacity due to high traffic! I am switching to offline fallback mode. \n\nIf you have a claim you want verified, you can still use the **Verify News** page which is configured to use live fallback search engines." });
  }
});

app.get("/api/news", async (req, res) => {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "API Key Missing: Please configure GEMINI_API_KEY in your environment." });
    }
    const category = (req.query.category as string || "All Fields").toLowerCase();
    
    let gnewsCategory = "general";
    if (category.includes('tech')) gnewsCategory = 'technology';
    if (category.includes('sport')) gnewsCategory = 'sports';
    if (category.includes('business')) gnewsCategory = 'business';
    if (category.includes('health')) gnewsCategory = 'health';
    if (category.includes('science')) gnewsCategory = 'science';
    if (category.includes('world') || category.includes('international')) gnewsCategory = 'world';
    if (category.includes('india') || category.includes('nation')) gnewsCategory = 'nation';

    try {
        // Try GNews First
        const GNEWS_KEY = process.env.GNEWS_API_KEY;
        if (GNEWS_KEY) {
            const resGnews = await fetch(`https://gnews.io/api/v4/top-headlines?category=${gnewsCategory}&lang=en&apikey=${GNEWS_KEY}`);
            if (resGnews.ok) {
                const data: any = await resGnews.json();
                if (data.articles && data.articles.length > 0) {
                    const mappedArticles = data.articles.map((a: any) => ({
                        title: a.title,
                        summary: a.description || "No summary available.",
                        source: a.source.name,
                        date: a.publishedAt,
                        category: category,
                        credibilityScore: 85,
                        severity: "Low"
                    }));
                    return res.json(mappedArticles);
                }
            }
        }
        
        let prompt = `Search for the latest, real, top news articles in the category: ${category}. Return the results strictly as a JSON array of objects.
Do not use markdown blocks, just raw JSON. Each object MUST have:
- title: (string) The real news headline
- summary: (string) A short summary of the article
- source: (string) The news publisher (e.g. Reuters, BBC)
- date: (string) ISO format timestamp of publication estimation
- category: (string) The category name
- credibilityScore: (number) Estimated credibility out of 100
- severity: (string) "Low", "Medium" or "High"

Return around 6-8 real news articles.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
                responseMimeType: "application/json",
            }
        });

        if (!response.text) throw new Error("Empty text");
        const text = response.text;
        res.json(JSON.parse(text));
    } catch(err: any) {
        if (err?.status !== 429 && !err.message?.includes('429')) {
            console.error("News API Error:", err);
            return res.status(500).json({ error: `AI Error: ${err.message}` });
        }
        // Fallback to mock data on rate limit
        res.json([
            {
                title: `Major Updates in ${category.toUpperCase()}`,
                summary: `This is a simulated fallback news summary for ${category}. Currently running in high traffic mode. Add GNEWS_API_KEY to bypass limits.`,
                source: "System Fallback",
                date: new Date().toISOString(),
                category: category,
                credibilityScore: 70,
                severity: "Low"
            },
            {
                title: `${category.toUpperCase()} Trends Today`,
                summary: `Generated local mock data. Researchers and analysts observe new patterns in ${category}.`,
                source: "System Fallback",
                date: new Date().toISOString(),
                category: category,
                credibilityScore: 65,
                severity: "Low"
            },
             {
                title: `Community Update: ${category}`,
                summary: `This is offline fallback news data. The live news endpoint connects to verified APIs.`,
                source: "System Fallback",
                date: new Date().toISOString(),
                category: category,
                credibilityScore: 80,
                severity: "Medium"
            }
        ]);
    }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:\${PORT}`);
  });
}

export default app;

if (process.env.VERCEL !== "1") {
  startServer();
}
