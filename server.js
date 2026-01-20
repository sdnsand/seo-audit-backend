const express = require('express');
const cors = require('cors');
// const chromeLauncher = require('chrome-launcher'); // REMOVED: Causes Crash
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { Groq } = require("groq-sdk");
const fs = require('fs');
const path = require('path');
const urlModule = require('url');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Set Node.js environment variable to ignore SSL certificate errors
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

// Robust HTTP client using native fetch with SSL bypass
async function fetchContent(url, options = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 8000);
    
    const response = await fetch(url, {
      signal: controller.signal,
      method: options.method || 'GET',
      headers: {
        'User-Agent': options.userAgent || 'SEO-Audit-Tool/1.0',
        ...options.headers
      }
    });
    
    clearTimeout(timeoutId);
    
    const text = await response.text();
    
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      text: () => Promise.resolve(text),
      headersGet: (name) => response.headers.get(name)
    };
  } catch (error) {
    console.error(`fetchContent error for ${url}:`, error.message);
    throw error;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); 

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const LOCAL_CHROME_PATH = path.join(__dirname, '.chrome-temp');
if (!fs.existsSync(LOCAL_CHROME_PATH)) fs.mkdirSync(LOCAL_CHROME_PATH);

// Helper function: Analyze keywords with semantic relevance
function analyzeKeywords(text, title, description) {
  const combinedText = `${title} ${description} ${text}`.toLowerCase();
  const words = combinedText.match(/\b[a-z]{3,}\b/g) || [];
  const wordFreq = {};
  
  // Common stop words to filter out
  const stopWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'who', 'way', 'use', 'she', 'had', 'this', 'that', 'from', 'they', 'with', 'have', 'what', 'were', 'when', 'your', 'said', 'each', 'which', 'their', 'time', 'will', 'about', 'would', 'there', 'could', 'other', 'after', 'first', 'never', 'these', 'think', 'where', 'being', 'those', 'shall', 'should', 'than', 'them', 'then', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your'];
  
  words.forEach(word => {
    if (!stopWords.includes(word)) {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    }
  });
  
  // Extract title and description keywords for relevance scoring
  const titleWords = title.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const descWords = description.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const importantKeywords = [...new Set([...titleWords, ...descWords])];
  
  // Calculate semantic relevance (keywords in title/description are more relevant)
  const sortedWords = Object.entries(wordFreq)
    .sort((a, b) => {
      // Prioritize keywords that appear in title/description
      const aInTitleDesc = importantKeywords.includes(a[0]) ? 1000 : 0;
      const bInTitleDesc = importantKeywords.includes(b[0]) ? 1000 : 0;
      return (b[1] + bInTitleDesc) - (a[1] + aInTitleDesc);
    })
    .slice(0, 10)
    .map(([word, count]) => ({
      word,
      count,
      density: ((count / words.length) * 100).toFixed(2),
      relevance: importantKeywords.includes(word) ? 'High' : 'Medium' // Semantic relevance indicator
    }));
  
  return {
    totalWords: words.length,
    uniqueWords: Object.keys(wordFreq).length,
    topKeywords: sortedWords,
    semanticRelevance: importantKeywords.length > 0 ? 'Good' : 'Needs Improvement' // Overall keyword relevance
  };
}

// Helper function: Evaluate content uniqueness
function evaluateContentUniqueness(text, title, description) {
  const wordCount = text.split(/\s+/).length;
  const charCount = text.length;
  const sentenceCount = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  const avgWordsPerSentence = sentenceCount > 0 ? wordCount / sentenceCount : 0;
  
  let score = 50; // Base score
  
  // Score based on length
  if (wordCount >= 300 && wordCount <= 2000) score += 20;
  else if (wordCount > 2000) score += 15;
  else if (wordCount < 300) score -= 20;
  
  // Score based on title/description relevance
  if (title && description) score += 15;
  if (title.length >= 30 && title.length <= 60) score += 10;
  if (description.length >= 120 && description.length <= 160) score += 10;
  
  // Score based on sentence structure
  if (avgWordsPerSentence >= 15 && avgWordsPerSentence <= 25) score += 5;
  
  return {
    score: Math.min(100, Math.max(0, score)),
    wordCount,
    sentenceCount,
    avgWordsPerSentence: avgWordsPerSentence.toFixed(1)
  };
}

// Helper function: Calculate readability score
function calculateReadability(text) {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const syllables = text.toLowerCase().match(/[aeiouy]+/g) || [];
  
  if (words.length === 0 || sentences.length === 0) return 50;
  
  const avgWordsPerSentence = words.length / sentences.length;
  const avgSyllablesPerWord = syllables.length / words.length;
  
  // Flesch Reading Ease simplified calculation
  const fleschScore = 206.835 - (1.015 * avgWordsPerSentence) - (84.6 * avgSyllablesPerWord);
  
  // Convert to 0-100 scale
  let score = fleschScore;
  if (score > 100) score = 100;
  if (score < 0) score = 0;
  
  return Math.round(score);
}

// Helper function: Analyze images
function analyzeImages(images) {
  const total = images.length;
  const hasAlt = images.filter(img => img.hasAlt).length;
  const missingAlt = total - hasAlt;
  
  // Estimate optimization (assuming images with width/height attributes are optimized)
  const optimized = images.filter(img => img.width && img.height).length;
  const optimizationRate = total > 0 ? Math.round((optimized / total) * 100) : 0;
  
  return {
    total,
    hasAlt,
    missingAlt,
    optimizationRate,
    averageSize: 0, // Would need actual image sizes
    largeFiles: 0 // Would need actual image sizes
  };
}

// Helper function: Analyze structured data
function analyzeStructuredData(structuredData, $) {
  const types = [];
  let organization = false;
  let article = false;
  let product = false;
  let breadcrumb = false;
  let localBusiness = false;
  let rating = false;
  
  structuredData.forEach(schema => {
    if (schema['@type']) {
      const type = Array.isArray(schema['@type']) ? schema['@type'][0] : schema['@type'];
      if (!types.includes(type)) types.push(type);
      
      if (type === 'Organization' || type === 'LocalBusiness') organization = true;
      if (type === 'Article' || type === 'NewsArticle') article = true;
      if (type === 'Product' || type === 'Service') product = true;
      if (type === 'BreadcrumbList') breadcrumb = true;
      if (type === 'LocalBusiness') localBusiness = true;
      if (schema.aggregateRating || schema.rating) rating = true;
    }
  });
  
  return {
    schemasFound: structuredData.length,
    types,
    organization,
    article,
    product,
    breadcrumb,
    localBusiness,
    rating
  };
}

// Helper function: Perform competitive analysis
function performCompetitiveAnalysis(metrics, structure) {
  const strengths = [];
  const weaknesses = [];
  
  if (metrics.performance >= 70) strengths.push('Strong performance metrics');
  else weaknesses.push('Performance needs improvement');
  
  if (metrics.seo >= 80) strengths.push('Excellent SEO score');
  else if (metrics.seo < 60) weaknesses.push('SEO score below average');
  
  if (structure.h1Count === 1) strengths.push('Proper H1 structure');
  else weaknesses.push('H1 tag issues');
  
  if (structure.readabilityScore >= 70) strengths.push('Good content readability');
  else weaknesses.push('Readability could be improved');
  
  const overallGrade = metrics.performance >= 80 && metrics.seo >= 80 ? 'A' :
                       metrics.performance >= 70 && metrics.seo >= 70 ? 'B' :
                       metrics.performance >= 60 || metrics.seo >= 60 ? 'C' : 'D';
  
  return {
    overallGrade,
    strengths,
    weaknesses
  };
}

// Helper function: Capture screenshot
async function captureScreenshot(targetUrl) {
  try {
    // Return a placeholder - actual screenshot would require browser instance
    return {
      captured: false,
      message: 'Screenshot capture not implemented'
    };
  } catch (error) {
    return {
      captured: false,
      error: error.message
    };
  }
}

// Helper function: Analyze domain with age estimation
async function analyzeDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    
    // Attempt to estimate domain age using free methods
    let ageEstimate = 'Unknown';
    let ageInYears = null;
    
    try {
      // Try to get first archive.org snapshot
      const archiveUrl = `https://web.archive.org/cdx/search/cdx?url=${hostname}&output=json&limit=1&collapse=urlkey`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      try {
        const response = await fetch(archiveUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const data = await response.json();
          if (data && data.length > 1 && data[1][1]) {
            const firstSnapshot = data[1][1];
            const year = parseInt(firstSnapshot.substring(0, 4));
            const month = parseInt(firstSnapshot.substring(4, 6));
            const day = parseInt(firstSnapshot.substring(6, 8));
            const firstSeen = new Date(year, month - 1, day);
            const now = new Date();
            ageInYears = Math.floor((now - firstSeen) / (1000 * 60 * 60 * 24 * 365));
            
            if (ageInYears >= 0) {
              if (ageInYears < 1) {
                const months = Math.floor((now - firstSeen) / (1000 * 60 * 60 * 24 * 30));
                ageEstimate = months < 1 ? 'Less than 1 month' : `${months} months`;
              } else if (ageInYears < 5) {
                ageEstimate = `${ageInYears} years`;
              } else if (ageInYears < 10) {
                ageEstimate = `${ageInYears} years (Established)`;
              } else {
                ageEstimate = `${ageInYears}+ years (Very Established)`;
              }
            }
          }
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
      }
    } catch (e) {}
    
    const isSubdomain = hostname.split('.').length > 2;
    const tld = hostname.split('.').pop();
    const domainName = isSubdomain ? hostname.split('.').slice(-2).join('.') : hostname;
    
    return {
      hostname,
      domainName: domainName,
      tld: tld,
      age: ageEstimate,
      ageInYears: ageInYears,
      ssl: url.startsWith('https://'),
      subdomain: isSubdomain,
      estimatedAuthority: ageInYears ? (ageInYears >= 3 ? 'Established' : ageInYears >= 1 ? 'Moderate' : 'New') : 'Unknown'
    };
  } catch (error) {
    return {
      hostname: 'Unknown',
      age: 'Unknown',
      ssl: url.startsWith('https://'),
      error: error.message
    };
  }
}

// Helper function: Check if a path is allowed by robots.txt rules
function checkPathRobots(path, disallowRules, allowRules) {
  let allowed = true;
  for (const rule of disallowRules) {
    if (path.startsWith(rule)) {
      allowed = false;
      for (const allowRule of allowRules) {
        if (path.startsWith(allowRule) && allowRule.length > rule.length) {
          allowed = true;
          break;
        }
      }
    }
  }
  return allowed;
}

// Helper function: Fetch and analyze robots.txt
async function analyzeRobotsTxt(url) {
  try {
    const urlObj = new URL(url);
    const currentPath = urlObj.pathname;
    const robotsUrl = `${urlObj.protocol}//${urlObj.hostname}/robots.txt`;
    
    const response = await fetchContent(robotsUrl, { timeout: 8000, userAgent: 'SEO-Audit-Tool/1.0' });
    
    if (response.ok) {
      const robotsContent = await response.text();
      const lines = robotsContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      
      let currentUserAgent = null;
      let blocksAll = false;
      let allowsAll = false;
      const sitemaps = [];
      const disallowRules = [];
      const allowRules = [];
      const subpageRules = {};
      
      for (const line of lines) {
        const lowerLine = line.toLowerCase();
        
        if (lowerLine.startsWith('user-agent:')) {
          const userAgent = line.substring(11).trim();
          currentUserAgent = userAgent === '*' ? '*' : userAgent;
          continue;
        }
        
        if (currentUserAgent === '*' && lowerLine.startsWith('disallow:')) {
          const path = line.substring(9).trim();
          if (path === '/' || path === '') blocksAll = true;
          else if (path) disallowRules.push(path);
        }
        
        if (currentUserAgent === '*' && lowerLine.startsWith('allow:')) {
          const path = line.substring(6).trim();
          if (path === '/' || path === '') allowsAll = true;
          else if (path) allowRules.push(path);
        }
        
        if (lowerLine.startsWith('sitemap:')) {
          const sitemapUrl = line.substring(8).trim();
          if (sitemapUrl) sitemaps.push(sitemapUrl);
        }
      }
      
      const currentPathAllowed = checkPathRobots(currentPath, disallowRules, allowRules);
      const allowsIndexing = !blocksAll || allowsAll;
      
      return {
        exists: true,
        allowsIndexing: allowsIndexing,
        currentPathAllowed: currentPathAllowed,
        blocksAll: blocksAll,
        hasSitemap: sitemaps.length > 0,
        sitemaps: sitemaps,
        disallowRules: disallowRules,
        allowRules: allowRules,
        content: robotsContent.substring(0, 2000),
        currentPath: currentPath
      };
    }
    
    return {
      exists: false,
      allowsIndexing: true,
      currentPathAllowed: true,
      hasSitemap: false,
      sitemaps: [],
      disallowRules: [],
      allowRules: []
    };
  } catch (error) {
    return {
      exists: false,
      allowsIndexing: true,
      currentPathAllowed: true,
      hasSitemap: false,
      sitemaps: [],
      error: error.message
    };
  }
}

// Helper function: Analyze meta robots tags
function analyzeMetaRobots($) {
  const metaRobots = $('meta[name="robots"]').attr('content') || 
                     $('meta[name="googlebot"]').attr('content') || '';
  
  if (!metaRobots) {
    return { found: false, content: null, allowsIndexing: true, allowsFollowing: true, directives: [] };
  }
  
  const directives = metaRobots.split(',').map(d => d.trim().toLowerCase());
  return {
    found: true,
    content: metaRobots,
    allowsIndexing: !directives.includes('noindex'),
    allowsFollowing: !directives.includes('nofollow'),
    directives: directives
  };
}

// Helper function: Analyze keyword intent alignment
function analyzeKeywordIntent(text, title, description) {
  const content = `${title} ${description} ${text}`.toLowerCase();
  
  const intentPatterns = {
    informational: ['what', 'how', 'why', 'guide', 'tutorial', 'learn', 'understand', 'explain', 'definition'],
    navigational: ['login', 'sign in', 'account', 'dashboard', 'home', 'contact'],
    transactional: ['buy', 'purchase', 'order', 'price', 'cost', 'discount', 'sale', 'shop', 'cart', 'checkout'],
    commercial: ['compare', 'best', 'review', 'vs', 'top', 'alternative', 'recommend']
  };
  
  const intentScores = {};
  for (const [intent, keywords] of Object.entries(intentPatterns)) {
    const matches = keywords.filter(keyword => content.includes(keyword)).length;
    intentScores[intent] = matches;
  }
  
  const primaryIntent = Object.keys(intentScores).reduce((a, b) => 
    intentScores[a] > intentScores[b] ? a : b
  );
  
  const maxPossibleMatches = intentPatterns[primaryIntent]?.length || 1;
  const confidence = intentScores[primaryIntent] > 0 ? 
    Math.min(100, (intentScores[primaryIntent] / maxPossibleMatches) * 100) : 0;
  
  return {
    primaryIntent: primaryIntent,
    confidence: Math.round(confidence),
    intentScores: intentScores,
    aligned: confidence > 30 
  };
}

// Helper function: Extract Open Graph data
function analyzeOpenGraph($, baseUrl) {
  const openGraph = {};
  
  const basicProps = ['og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:site_name', 'og:locale'];
  
  basicProps.forEach(prop => {
    const value = $(`meta[property="${prop}"], meta[name="${prop}"]`).attr('content');
    if (value) openGraph[prop] = value;
  });
  
  openGraph.images = [];
  $('meta[property^="og:image"]').each((i, element) => {
    const image = $(element).attr('content');
    if (image && !openGraph.images.some(img => img.url === image)) {
      openGraph.images.push({ url: image });
    }
  });
  
  const hasBasicOG = !!(openGraph['og:title'] || openGraph['og:description'] || openGraph['og:image']);
  
  return {
    found: hasBasicOG,
    basic: {
      title: openGraph['og:title'] || null,
      description: openGraph['og:description'] || null,
      type: openGraph['og:type'] || null,
      url: openGraph['og:url'] || null,
      siteName: openGraph['og:site_name'] || null
    },
    images: openGraph.images,
    completeness: hasBasicOG ? 80 : 0
  };
}

// Helper function: Analyze hreflang tags
function analyzeHreflang($, baseUrl, htmlContent = '') {
  const hreflangs = [];
  const languages = new Set();
  
  $('link[rel="alternate"][hreflang]').each((i, link) => {
    const hreflang = $(link).attr('hreflang');
    let href = $(link).attr('href');
    
    if (hreflang && href) {
      if (!href.startsWith('http')) href = new URL(href, baseUrl).href;
      languages.add(hreflang);
      hreflangs.push({ lang: hreflang, href: href });
    }
  });
  
  const xDefault = $('link[rel="alternate"][hreflang="x-default"]').attr('href');
  
  return {
    found: hreflangs.length > 0,
    count: hreflangs.length,
    languages: Array.from(languages),
    hasXDefault: !!xDefault,
    isValid: hreflangs.length > 0
  };
}

// Helper function: Extract detailed link information
function extractDetailedLinks($, targetUrl) {
  const internalLinks = [];
  const externalLinks = [];
  let domain = '';
  
  try { domain = new URL(targetUrl).hostname; } catch (e) {}
  
  $('a[href]').each((i, link) => {
    const href = $(link).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    
    const isInternal = href.startsWith('/') || href.includes(domain);
    const fullUrl = href.startsWith('http') ? href : (isInternal ? new URL(href, targetUrl).href : href);
    
    const linkData = { url: fullUrl, isNofollow: $(link).attr('rel')?.includes('nofollow') || false };
    
    if (isInternal) internalLinks.push(linkData);
    else externalLinks.push(linkData);
  });
  
  return { internal: internalLinks, external: externalLinks, internalCount: internalLinks.length, externalCount: externalLinks.length };
}

// Helper function: Check for sitemap
async function checkSitemap(url, robotsTxtSitemaps = [], $ = null) {
    // Simplified for robustness
    return { found: robotsTxtSitemaps.length > 0, sitemaps: robotsTxtSitemaps, analyzed: false };
}

// Helper function: Check specific subpage paths
async function checkSubpagePaths(mainUrl, robotsTxtData, sitemapData) {
    // Simplified stub
    return { summary: { totalChecked: 0 } };
}

async function scrapeSite(targetUrl) {
  console.log(`Step 1: Launching Chrome for ${targetUrl}...`);

  // --- FIX START: Dynamic Imports for ESM Libraries ---
  const { default: lighthouse } = await import('lighthouse');
  const chromeLauncher = await import('chrome-launcher'); // Imported here to prevent crash
  // --- FIX END ---
  
  // Launch Chrome
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    userDataDir: LOCAL_CHROME_PATH 
  });
  
  console.log("Step 2: Running Lighthouse...");
  let metrics = { performance: 0, seo: 0, accessibility: 0, bestPractices: 0, mobileFriendly: false, mobileScore: 0, technical: {}, security: {} };
  
  try {
      const options = { 
        logLevel: 'error', 
        output: 'json', 
        onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'], 
        port: chrome.port,
        formFactor: 'mobile',
        screenEmulation: { mobile: true }
      };
      
      const runnerResult = await lighthouse(targetUrl, options);
      const report = runnerResult.lhr;

      if (report.categories.performance) metrics.performance = Math.round(report.categories.performance.score * 100);
      if (report.categories.seo) metrics.seo = Math.round(report.categories.seo.score * 100);
      if (report.categories.accessibility) metrics.accessibility = Math.round(report.categories.accessibility.score * 100);
      if (report.categories['best-practices']) metrics.bestPractices = Math.round(report.categories['best-practices'].score * 100);
      
      const viewport = report.audits['viewport']?.score === 1;
      const tapTargets = report.audits['tap-targets']?.score === 1;
      
      metrics.mobileFriendly = viewport && tapTargets;
      metrics.mobileScore = metrics.mobileFriendly ? 90 : 50;

  } catch (lhError) { 
      console.log("⚠️ Lighthouse error:", lhError.message); 
  }

  // B. Puppeteer
  console.log("Step 3: Grabbing HTML via Puppeteer...");
  let html = "";
  try {
      const browser = await puppeteer.connect({ browserURL: `http://localhost:${chrome.port}` });
      const page = await browser.newPage();
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      html = await page.content();
      await page.close();
      browser.disconnect();
  } catch (pupError) { 
      console.error("⚠️ Puppeteer error:", pupError.message); 
      html = "<body></body>"; 
  }

  // C. Deep Analysis
  const $ = cheerio.load(html);
  let domain = "site";
  try { domain = new urlModule.URL(targetUrl).hostname; } catch(e) {}

  const totalImages = $('img').length;
  const missingAlt = $('img:not([alt])').length;
  const detailedLinks = extractDetailedLinks($, targetUrl);
  
  $('script').remove(); $('style').remove();
  const textContent = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 2500);
  const fullTextContent = $('body').text().replace(/\s+/g, ' ').trim();
  
  const title = $('title').text().trim() || '';
  const description = $('meta[name="description"]').attr('content') || '';
  
  const structure = {
    h1: $('h1').text().trim() || "Missing",
    h1Count: $('h1').length,
    title: title,
    description: description,
    headings: {},
    links: { internal: detailedLinks.internalCount, external: detailedLinks.externalCount },
    metaTags: {},
    structuredData: [],
    wordCount: textContent.split(/\s+/).length,
    readabilityScore: calculateReadability(textContent),
    keywordAnalysis: analyzeKeywords(fullTextContent, title, description),
    keywordIntent: analyzeKeywordIntent(fullTextContent, title, description),
    contentUniqueness: evaluateContentUniqueness(fullTextContent, title, description),
    domainInfo: await analyzeDomain(targetUrl),
    robotsTxt: await analyzeRobotsTxt(targetUrl),
    metaRobots: analyzeMetaRobots($),
    images: { total: totalImages, missingAlt: missingAlt, hasAlt: totalImages - missingAlt },
    imagesDetailed: [],
    hreflang: analyzeHreflang($, targetUrl),
    openGraph: analyzeOpenGraph($, targetUrl),
    socials: 'Analyzed'
  };

  await chrome.kill();
  try { fs.rmSync(LOCAL_CHROME_PATH, { recursive: true, force: true }); } catch (e) {}

  return { metrics, structure, textContent, domain: targetUrl };
}

async function getAIAdvice(data) {
  console.log("Step 4: Getting comprehensive AI analysis...");
  
  // Safety check
  if (!data || !data.metrics) return { health_score: 50, summary: "Analysis failed", recommendations: [] };

  const prompt = `
    Analyze this website:
    URL: ${data.url}
    Technical: Speed ${data.metrics.performance}/100, SEO ${data.metrics.seo}/100
    Content: "${data.textContent.substring(0, 1000)}..."
    
    Return STRICT JSON ONLY:
    {
      "health_score": <number 0-100>,
      "summary": "<summary>",
      "strengths": ["<strength 1>", "<strength 2>"],
      "weaknesses": ["<weakness 1>", "<weakness 2>"],
      "recommendations": [
        { "priority": "Critical"|"Medium"|"Quick Win", "category": "Technical", "issue": "<title>", "fix": "<how to fix>" }
      ]
    }
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      response_format: { type: "json_object" }
    });
    return JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error("❌ AI ERROR:", e.message);
    return { health_score: 50, summary: "AI Analysis Failed", recommendations: [] };
  }
}

// Email transporter setup (optional)
let transporter = null;
if (process.env.EMAIL_HOST) {
  transporter = nodemailer.createTransporter({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT || 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
}

app.post('/api/audit', async (req, res) => {
  try {
    let { url, email } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });
    if (!url.startsWith('http')) url = 'https://' + url;
    
    console.log(`🚀 Starting audit for: ${url}`);
    const rawData = await scrapeSite(url);
    const aiReport = await getAIAdvice({ url, ...rawData });
    
    const finalReport = {
      url,
      timestamp: new Date().toISOString(),
      metrics: rawData.metrics,
      structure: rawData.structure,
      report: aiReport
    };
    
    if (email && transporter) {
      // Send email logic here (omitted for brevity)
    }
    
    res.json(finalReport);
    
  } catch (error) {
    console.error("❌ AUDIT ERROR:", error);
    res.status(500).json({ error: "Audit failed", details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});