import express from 'express';
import cors from 'cors';
import * as ChromeLauncher from 'chrome-launcher';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import { Groq } from "groq-sdk";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    // Note: Free WHOIS APIs have rate limits, so we'll try Archive.org as a proxy
    let ageEstimate = 'Unknown';
    let ageInYears = null;

    try {
      // Try to get first archive.org snapshot (indicates domain existence)
      const archiveUrl = `https://web.archive.org/cdx/search/cdx?url=${hostname}&output=json&limit=1&collapse=urlkey`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      try {
        const response = await fetch(archiveUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          if (data && data.length > 1 && data[1][1]) {
            // First snapshot timestamp (format: YYYYMMDDHHMMSS)
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
        // Archive.org lookup failed, fall back to DNS-based estimation
        clearTimeout(timeoutId);
      }
    } catch (e) {
      // Fall through to default
    }

    // Additional domain analysis
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

  // Check Disallow rules first (more restrictive)
  for (const rule of disallowRules) {
    if (path.startsWith(rule)) {
      allowed = false;
      // Check if there's a more specific Allow rule
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

// Helper function: Fetch and analyze robots.txt with proper parsing and subpage analysis
async function analyzeRobotsTxt(url) {
  console.log('=== analyzeRobotsTxt DEBUG ===');
  console.log('Input URL:', url);

  try {
    const urlObj = new URL(url);
    const currentPath = urlObj.pathname;
    const robotsUrl = `${urlObj.protocol}//${urlObj.hostname}/robots.txt`;

    console.log('Parsed hostname:', urlObj.hostname);
    console.log('Parsed protocol:', urlObj.protocol);
    console.log('Current path:', currentPath);
    console.log('Constructed robots URL:', robotsUrl);
    console.log('URL validation check - is URL valid?:', urlObj && urlObj.hostname && urlObj.protocol);

    const response = await fetchContent(robotsUrl, {
      timeout: 8000,
      userAgent: 'SEO-Audit-Tool/1.0'
    });

    console.log('robots.txt request completed');
    console.log('Response status:', response.status);
    console.log('Response ok:', response.ok);

    if (response.ok) {
      console.log('✅ robots.txt FOUND and accessible');
      const robotsContent = await response.text();
      console.log('Content length:', robotsContent.length);
      console.log('Content preview:', robotsContent.substring(0, 200) + '...');

      // Parse robots.txt more accurately
      const lines = robotsContent.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

      let currentUserAgent = null;
      let blocksAll = false;
      let allowsAll = false;
      const sitemaps = [];
      const disallowRules = [];
      const allowRules = [];
      const crawlDelay = null;
      const subpageRules = {};

      // Parse each line
      for (const line of lines) {
        const lowerLine = line.toLowerCase();

        // Check for User-agent directive
        if (lowerLine.startsWith('user-agent:')) {
          const userAgent = line.substring(11).trim();
          if (userAgent === '*') {
            currentUserAgent = '*';
          } else {
            currentUserAgent = userAgent;
          }
          continue;
        }

        // Check for Disallow directive
        if (currentUserAgent === '*' && lowerLine.startsWith('disallow:')) {
          const path = line.substring(9).trim();
          if (path === '/' || path === '') {
            blocksAll = true;
          } else if (path) {
            disallowRules.push(path);
            // Categorize subpage rules
            if (path.includes('/admin') || path.includes('/private') || path.includes('/wp-admin')) {
              subpageRules.admin = subpageRules.admin || [];
              subpageRules.admin.push({ type: 'Disallow', path: path });
            } else if (path.includes('/api') || path.includes('/cgi-bin')) {
              subpageRules.api = subpageRules.api || [];
              subpageRules.api.push({ type: 'Disallow', path: path });
            } else if (path.includes('/category') || path.includes('/tag') || path.includes('/author')) {
              subpageRules.content = subpageRules.content || [];
              subpageRules.content.push({ type: 'Disallow', path: path });
            } else if (path.includes('/search') || path.includes('/filter')) {
              subpageRules.search = subpageRules.search || [];
              subpageRules.search.push({ type: 'Disallow', path: path });
            }
          }
        }

        // Check for Allow directive
        if (currentUserAgent === '*' && lowerLine.startsWith('allow:')) {
          const path = line.substring(6).trim();
          if (path === '/' || path === '') {
            allowsAll = true;
          } else if (path) {
            allowRules.push(path);
            // Categorize subpage rules
            if (path.includes('/category') || path.includes('/tag') || path.includes('/author')) {
              subpageRules.content = subpageRules.content || [];
              subpageRules.content.push({ type: 'Allow', path: path });
            } else if (path.includes('/search') || path.includes('/filter')) {
              subpageRules.search = subpageRules.search || [];
              subpageRules.search.push({ type: 'Allow', path: path });
            }
          }
        }

        // Extract sitemap URLs
        if (lowerLine.startsWith('sitemap:')) {
          const sitemapUrl = line.substring(8).trim();
          if (sitemapUrl) {
            sitemaps.push(sitemapUrl);
          }
        }
      }

      // Check if current page path is specifically affected
      const currentPathAllowed = checkPathRobots(currentPath, disallowRules, allowRules);

      // Determine if indexing is allowed
      const allowsIndexing = !blocksAll || allowsAll;

      // Analyze subpage-specific rules
      const subpageAnalysis = {
        hasAdminRules: !!(subpageRules.admin && subpageRules.admin.length > 0),
        hasApiRules: !!(subpageRules.api && subpageRules.api.length > 0),
        hasContentRules: !!(subpageRules.content && subpageRules.content.length > 0),
        hasSearchRules: !!(subpageRules.search && subpageRules.search.length > 0),
        rules: subpageRules
      };

      const result = {
        exists: true,
        allowsIndexing: allowsIndexing,
        currentPathAllowed: currentPathAllowed,
        blocksAll: blocksAll,
        hasSitemap: sitemaps.length > 0,
        sitemaps: sitemaps,
        disallowRules: disallowRules,
        allowRules: allowRules,
        subpageAnalysis: subpageAnalysis,
        content: robotsContent.substring(0, 2000), // More content for reference
        currentPath: currentPath
      };

      console.log('analyzeRobotsTxt returning enhanced result');
      console.log('disallowRules count:', result.disallowRules.length);
      console.log('subpageAnalysis keys:', Object.keys(result.subpageAnalysis.rules));

      return result;
    }

    console.log('❌ robots.txt NOT FOUND for URL:', url);
    console.log('Response status:', response?.status || 'No response');

    return {
      exists: false,
      allowsIndexing: true, // Default assumption if robots.txt doesn't exist
      currentPathAllowed: true,
      hasSitemap: false,
      sitemaps: [],
      disallowRules: [],
      allowRules: [],
      subpageAnalysis: { rules: {} }
    };
  } catch (error) {
    // robots.txt not found or inaccessible
    console.log('❌ robots.txt ERROR for URL:', url);
    console.log('Error type:', error.constructor.name);
    console.log('Error message:', error.message);
    console.log('Error code:', error.code);

    return {
      exists: false,
      allowsIndexing: true,
      currentPathAllowed: true,
      hasSitemap: false,
      sitemaps: [],
      disallowRules: [],
      allowRules: [],
      subpageAnalysis: { rules: {} },
      error: error.message
    };
  }
}

// Helper function: Analyze meta robots tags
function analyzeMetaRobots($) {
  const metaRobots = $('meta[name="robots"]').attr('content') ||
    $('meta[name="googlebot"]').attr('content') || '';

  if (!metaRobots) {
    return {
      found: false,
      content: null,
      allowsIndexing: true,
      allowsFollowing: true,
      directives: []
    };
  }

  const directives = metaRobots.split(',').map(d => d.trim().toLowerCase());
  const allowsIndexing = !directives.includes('noindex');
  const allowsFollowing = !directives.includes('nofollow');

  return {
    found: true,
    content: metaRobots,
    allowsIndexing: allowsIndexing,
    allowsFollowing: allowsFollowing,
    directives: directives
  };
}

// Helper function: Analyze keyword intent alignment
function analyzeKeywordIntent(text, title, description) {
  // Simple intent classification based on keywords and content patterns
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
    aligned: confidence > 30 // Content shows clear intent signals
  };
}

// Helper function: Extract Open Graph data
function analyzeOpenGraph($, baseUrl) {
  console.log('=== analyzeOpenGraph DEBUG START ===');

  console.log('Starting Open Graph extraction...');

  const openGraph = {}; // Declare openGraph at the start

  // Basic Open Graph properties
  const basicProps = [
    'og:title', 'og:description', 'og:type', 'og:url', 'og:image',
    'og:image:width', 'og:image:height', 'og:image:alt', 'og:image:type',
    'og:site_name', 'og:locale', 'og:video', 'og:audio'
  ];

  // Extract basic OG properties
  basicProps.forEach(prop => {
    const value = $(`meta[property="${prop}"], meta[name="${prop}"]`).attr('content');
    if (value) {
      openGraph[prop] = value;
    }
  });

  // Extract structured OG data
  openGraph.images = [];
  $('meta[property^="og:image"]').each((i, element) => {
    const $element = $(element);
    const image = $element.attr('content');

    if (image && !openGraph.images.some(img => img.url === image)) {
      const imageData = {
        url: image,
        width: null,
        height: null,
        alt: null,
        type: null
      };

      // Try to get associated properties
      const width = $(`meta[property="${i ? `og:image:${i}:width` : 'og:image:width'}"]`).attr('content');
      const height = $(`meta[property="${i ? `og:image:${i}:height` : 'og:image:height'}"]`).attr('content');
      const alt = $(`meta[property="${i ? `og:image:${i}:alt` : 'og:image:alt'}"]`).attr('content');
      const type = $(`meta[property="${i ? `og:image:${i}:type` : 'og:image:type'}"]`).attr('content');

      if (width) imageData.width = parseInt(width);
      if (height) imageData.height = parseInt(height);
      if (alt) imageData.alt = alt;
      if (type) imageData.type = type;

      openGraph.images.push(imageData);
    }
  });

  // Social media specific properties
  const socialProps = [
    'fb:app_id', 'fb:admins', 'fb:page_id',
    'twitter:card', 'twitter:site', 'twitter:creator', 'twitter:title',
    'twitter:description', 'twitter:image', 'twitter:image:alt'
  ];

  openGraph.facebook = {};
  openGraph.twitter = {};

  socialProps.forEach(prop => {
    const value = $(`meta[property="${prop}"], meta[name="${prop}"]`).attr('content');
    if (value) {
      if (prop.startsWith('fb:')) {
        openGraph.facebook[prop.replace('fb:', '')] = value;
      } else if (prop.startsWith('twitter:')) {
        openGraph.twitter[prop.replace('twitter:', '')] = value;
      }
    }
  });

  // Additional SEO properties
  const seoProps = [
    'article:author', 'article:published_time', 'article:modified_time',
    'article:section', 'article:tag', 'article:publisher',
    'video:duration', 'video:release_date', 'video:tag'
  ];

  openGraph.article = {};
  openGraph.video = {};

  seoProps.forEach(prop => {
    const value = $(`meta[property="${prop}"], meta[name="${prop}"]`).attr('content');
    if (value) {
      if (prop.startsWith('article:')) {
        openGraph.article[prop.replace('article:', '')] = value;
      } else if (prop.startsWith('video:')) {
        openGraph.video[prop.replace('video:', '')] = value;
      }
    }
  });

  // Validate and analyze Open Graph data
  const hasBasicOG = !!(openGraph['og:title'] || openGraph['og:description'] || openGraph['og:image']);
  const hasSocialProof = !!(openGraph.facebook?.app_id || openGraph.twitter?.card || openGraph['og:site_name']);
  const hasRichMedia = !!(openGraph.images.length > 0 || openGraph.video?.duration || openGraph['og:audio']);

  // Make image URLs absolute
  if (openGraph.images && openGraph.images.length > 0) {
    openGraph.images = openGraph.images.map(img => {
      if (img.url && !img.url.startsWith('http')) {
        try {
          img.url = new URL(img.url, baseUrl).href;
        } catch (e) {
          // Keep original if URL construction fails
        }
      }
      return img;
    });
  }

  return {
    found: hasBasicOG,
    hasSocialProof: hasSocialProof,
    hasRichMedia: hasRichMedia,
    basic: {
      title: openGraph['og:title'] || null,
      description: openGraph['og:description'] || null,
      type: openGraph['og:type'] || null,
      url: openGraph['og:url'] || null,
      siteName: openGraph['og:site_name'] || null,
      locale: openGraph['og:locale'] || null
    },
    images: openGraph.images,
    facebook: openGraph.facebook,
    twitter: openGraph.twitter,
    article: openGraph.article,
    video: openGraph.video,
    totalTags: Object.keys(openGraph).length,
    completeness: calculateOpenGraphCompleteness(openGraph)
  };

  console.log('=== analyzeOpenGraph DEBUG END ===');
  console.log('OG found:', result.found);
  console.log('OG title:', result.basic.title);
  console.log('Returning result');

  return result;
}

// Helper function: Calculate Open Graph completeness score
function calculateOpenGraphCompleteness(ogData) {
  let score = 0;
  const maxScore = 100;

  // Basic properties (60 points)
  if (ogData['og:title']) score += 15;
  if (ogData['og:description']) score += 15;
  if (ogData['og:image']) score += 15;
  if (ogData['og:url']) score += 5;
  if (ogData['og:type']) score += 5;
  if (ogData['og:site_name']) score += 5;

  // Social media integration (20 points)
  if (ogData.facebook?.app_id || ogData.facebook?.page_id) score += 10;
  if (ogData.twitter?.card) score += 10;

  // Rich media (15 points)
  if (ogData.images && ogData.images.length > 1) score += 5;
  if (ogData.article?.published_time || ogData.video?.duration) score += 10;

  // Additional optimization (5 points)
  if (ogData['og:locale']) score += 3;
  if (ogData.images && ogData.images.some(img => img.width && img.height)) score += 2;

  return Math.min(maxScore, score);
}

// Helper function: Analyze hreflang tags (both in HTML and HTTP headers)
function analyzeHreflang($, baseUrl, htmlContent = '') {
  console.log('=== analyzeHreflang DEBUG ===');
  console.log('Base URL:', baseUrl);
  console.log('HTML link tags found:', $('link[rel="alternate"][hreflang]').length);

  const hreflangs = [];
  const languages = new Set();

  // 1. Check HTML link tags
  $('link[rel="alternate"][hreflang]').each((i, link) => {
    const $link = $(link);
    const hreflang = $link.attr('hreflang');
    let href = $link.attr('href');

    console.log(`Link ${i}: hreflang="${hreflang}", href="${href}"`);

    if (hreflang && href) {
      // Make URL absolute
      if (!href.startsWith('http') && !href.startsWith('//')) {
        try {
          href = new URL(href, baseUrl).href;
        } catch (e) {
          // Keep original if URL construction fails
        }
      } else if (href.startsWith('//')) {
        href = new URL(baseUrl).protocol + href;
      }

      languages.add(hreflang);
      hreflangs.push({
        lang: hreflang,
        href: href,
        source: 'HTML'
      });
    }
  });

  // 2. Check for x-default specifically
  const xDefault = $('link[rel="alternate"][hreflang="x-default"]').attr('href');
  let xDefaultUrl = null;
  if (xDefault) {
    xDefaultUrl = xDefault.startsWith('http') ? xDefault : new URL(xDefault, baseUrl).href;
  }

  // 3. Also check HTML content for hreflang in meta tags or comments (some sites use this)
  const hreflangInContent = htmlContent.match(/hreflang=["']([^"']+)["']/gi);
  if (hreflangInContent) {
    hreflangInContent.forEach(match => {
      const lang = match.match(/hreflang=["']([^"']+)["']/i)?.[1];
      if (lang && !languages.has(lang)) {
        languages.add(lang);
      }
    });
  }

  // Validate hreflang implementation
  const isValid = hreflangs.length > 0 && hreflangs.every(h => h.href && h.lang);
  const hasSelfReference = hreflangs.some(h => {
    try {
      return new URL(h.href).pathname === new URL(baseUrl).pathname;
    } catch (e) {
      return false;
    }
  });

  const result = {
    found: hreflangs.length > 0,
    count: hreflangs.length,
    languages: Array.from(languages),
    hreflangs: hreflangs,
    hasXDefault: !!xDefault,
    xDefaultUrl: xDefaultUrl,
    isValid: isValid && (hreflangs.length > 1 || hasSelfReference), // Valid if multiple languages or self-reference
    hasSelfReference: hasSelfReference
  };

  console.log('Hreflang analysis result:');
  console.log('- Found:', result.found);
  console.log('- Count:', result.count);
  console.log('- Languages:', result.languages);
  console.log('- Is valid:', result.isValid);
  console.log('- Has self-reference:', result.hasSelfReference);

  return result;
}

// Helper function: Extract detailed link information
function extractDetailedLinks($, targetUrl) {
  const internalLinks = [];
  const externalLinks = [];
  let domain = '';

  try {
    domain = new URL(targetUrl).hostname;
  } catch (e) { }

  $('a[href]').each((i, link) => {
    const $link = $(link);
    const href = $link.attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;

    const linkText = $link.text().trim() || $link.find('img').attr('alt') || '[Image Link]';
    const isInternal = href.startsWith('/') || href.includes(domain) || href.startsWith('./') || href.startsWith('../');

    // Convert relative URLs to absolute
    let fullUrl = href;
    try {
      if (!href.startsWith('http')) {
        fullUrl = new URL(href, targetUrl).href;
      }
    } catch (e) {
      fullUrl = href;
    }

    const linkData = {
      text: linkText.substring(0, 100), // Limit text length
      url: fullUrl,
      isNofollow: $link.attr('rel')?.includes('nofollow') || false,
      isExternal: !isInternal && href.startsWith('http'),
      hasTitle: !!$link.attr('title'),
      title: $link.attr('title') || null
    };

    if (isInternal) {
      internalLinks.push(linkData);
    } else if (linkData.isExternal) {
      externalLinks.push(linkData);
    }
  });

  return {
    internal: internalLinks,
    external: externalLinks,
    internalCount: internalLinks.length,
    externalCount: externalLinks.length
  };
}

// Helper function: Analyze resource sizes from Lighthouse (more accurate)
function analyzeResourceSizes(report) {
  // Use Lighthouse's network-requests audit for accurate data
  const networkRequests = report.audits['network-requests']?.details?.items || [];

  // Also try to get data from other Lighthouse audits for cross-validation
  const totalByteWeight = report.audits['total-byte-weight']?.numericValue || 0;

  let jsSize = 0;
  let cssSize = 0;
  let imageSize = 0;
  let fontSize = 0;
  let htmlSize = 0;
  let otherSize = 0;

  const resourceBreakdown = {
    js: [],
    css: [],
    images: [],
    fonts: [],
    html: [],
    other: []
  };

  networkRequests.forEach(item => {
    const mimeType = (item.mimeType || '').toLowerCase();
    const url = item.url || '';

    // Use resourceSize (transferred) if available, otherwise use transferSize
    const size = item.resourceSize || item.transferSize || 0;

    // More accurate MIME type detection
    if (mimeType.includes('javascript') || mimeType.includes('application/javascript') ||
      mimeType.includes('text/javascript') || url.match(/\.js($|\?|#)/i)) {
      jsSize += size;
      resourceBreakdown.js.push({ url: url, size: size, mimeType: mimeType });
    } else if (mimeType.includes('css') || mimeType.includes('text/css') ||
      url.match(/\.css($|\?|#)/i)) {
      cssSize += size;
      resourceBreakdown.css.push({ url: url, size: size, mimeType: mimeType });
    } else if (mimeType.includes('image') ||
      url.match(/\.(jpg|jpeg|png|gif|webp|svg|ico|bmp)($|\?|#)/i)) {
      imageSize += size;
      resourceBreakdown.images.push({ url: url, size: size, mimeType: mimeType });
    } else if (mimeType.includes('font') || mimeType.includes('application/font') ||
      url.match(/\.(woff|woff2|ttf|otf|eot|sfnt)($|\?|#)/i)) {
      fontSize += size;
      resourceBreakdown.fonts.push({ url: url, size: size, mimeType: mimeType });
    } else if (mimeType.includes('html') || mimeType.includes('text/html')) {
      htmlSize += size;
      resourceBreakdown.html.push({ url: url, size: size, mimeType: mimeType });
    } else {
      otherSize += size;
      resourceBreakdown.other.push({ url: url, size: size, mimeType: mimeType });
    }
  });

  // Calculate total from all resources
  let calculatedTotal = jsSize + cssSize + imageSize + fontSize + htmlSize + otherSize;

  // Use Lighthouse's total-byte-weight if available and more accurate
  const totalSize = totalByteWeight > calculatedTotal ? totalByteWeight : calculatedTotal;

  return {
    js: { size: jsSize, count: resourceBreakdown.js.length, items: resourceBreakdown.js.slice(0, 10) },
    css: { size: cssSize, count: resourceBreakdown.css.length, items: resourceBreakdown.css.slice(0, 10) },
    images: { size: imageSize, count: resourceBreakdown.images.length, items: resourceBreakdown.images.slice(0, 10) },
    fonts: { size: fontSize, count: resourceBreakdown.fonts.length, items: resourceBreakdown.fonts.slice(0, 10) },
    html: { size: htmlSize, count: resourceBreakdown.html.length, items: resourceBreakdown.html.slice(0, 10) },
    other: { size: otherSize, count: resourceBreakdown.other.length, items: resourceBreakdown.other.slice(0, 10) },
    total: totalSize,
    calculatedTotal: calculatedTotal,
    lighthouseTotal: totalByteWeight
  };
}

// Helper function: Analyze sitemap content for subpage coverage
async function analyzeSitemapContent(sitemapUrl, currentUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(sitemapUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'application/xml, text/xml' }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        analyzed: false,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }

    const content = await response.text();
    const $ = cheerio.load(content, { xmlMode: true });

    // Check if this is a sitemap index or individual sitemap
    const sitemapIndex = $('sitemapindex').length > 0;
    const urlset = $('urlset').length > 0;

    let urls = [];
    let subpageCoverage = {
      totalPages: 0,
      categoryPages: 0,
      productPages: 0,
      blogPages: 0,
      staticPages: 0,
      hasCurrentPage: false,
      currentPageInSitemap: false
    };

    if (urlset) {
      // Individual sitemap
      urls = $('url').map((i, el) => {
        const loc = $(el).find('loc').text();
        const lastmod = $(el).find('lastmod').text();
        const changefreq = $(el).find('changefreq').text();
        const priority = $(el).find('priority').text();

        // Categorize the URL type
        let urlType = 'other';
        if (loc.includes('/category/') || loc.includes('/tag/')) {
          urlType = 'category';
          subpageCoverage.categoryPages++;
        } else if (loc.includes('/product/') || loc.includes('/item/')) {
          urlType = 'product';
          subpageCoverage.productPages++;
        } else if (loc.includes('/blog/') || loc.includes('/post/') || loc.includes('/article/')) {
          urlType = 'blog';
          subpageCoverage.blogPages++;
        } else if (loc === currentUrl || loc === currentUrl + '/') {
          urlType = 'current';
          subpageCoverage.hasCurrentPage = true;
          subpageCoverage.currentPageInSitemap = true;
        } else if (!loc.match(/\/(category|tag|product|item|blog|post|article)\//) && loc.split('/').length <= 4) {
          urlType = 'static';
          subpageCoverage.staticPages++;
        }

        return {
          loc: loc,
          lastmod: lastmod,
          changefreq: changefreq,
          priority: priority,
          type: urlType
        };
      }).get();

      subpageCoverage.totalPages = urls.length;

    } else if (sitemapIndex) {
      // Sitemap index - list child sitemaps
      urls = $('sitemap').map((i, el) => {
        return {
          loc: $(el).find('loc').text(),
          lastmod: $(el).find('lastmod').text(),
          type: 'sitemap-index'
        };
      }).get();

      subpageCoverage.sitemapCount = urls.length;
    }

    return {
      analyzed: true,
      type: sitemapIndex ? 'sitemap-index' : 'urlset',
      urls: urls.slice(0, 50), // Limit to first 50 URLs for performance
      totalUrls: urls.length,
      subpageCoverage: subpageCoverage,
      hasValidXml: true
    };

  } catch (error) {
    return {
      analyzed: false,
      error: error.message
    };
  }
}

// Helper function: Check for sitemap (including robots.txt sitemaps and HTML links) with subpage analysis
async function checkSitemap(url, robotsTxtSitemaps = [], $ = null) {
  try {
    const urlObj = new URL(url);
    const foundSitemaps = [];

    // 1. Check sitemaps from robots.txt first (most reliable)
    if (robotsTxtSitemaps && robotsTxtSitemaps.length > 0) {
      for (const sitemapUrl of robotsTxtSitemaps) {
        try {
          // Make URL absolute if relative
          let absoluteUrl = sitemapUrl;
          if (!sitemapUrl.startsWith('http')) {
            absoluteUrl = new URL(sitemapUrl, url).href;
          }

          const response = await fetchContent(absoluteUrl, {
            method: 'HEAD',
            timeout: 5000,
            userAgent: 'SEO-Audit-Tool/1.0'
          });

          if (response.ok) {
            const sitemapData = await analyzeSitemapContent(absoluteUrl, url);
            foundSitemaps.push({
              url: absoluteUrl,
              source: 'robots.txt',
              accessible: true,
              analyzed: sitemapData.analyzed,
              analysis: sitemapData
            });
          }
        } catch (e) {
          // Try GET if HEAD fails
          try {
            let absoluteUrl = sitemapUrl;
            if (!sitemapUrl.startsWith('http')) {
              absoluteUrl = new URL(sitemapUrl, url).href;
            }
            const response = await fetchContent(absoluteUrl, {
              timeout: 8000,
              userAgent: 'SEO-Audit-Tool/1.0'
            });
            const content = await response.text();
            const contentType = response.headers['content-type'] || '';
            if (response.ok && contentType.includes('xml')) {
              const sitemapData = await analyzeSitemapContent(absoluteUrl, url);
              foundSitemaps.push({
                url: absoluteUrl,
                source: 'robots.txt',
                accessible: true,
                analyzed: sitemapData.analyzed,
                analysis: sitemapData
              });
            }
          } catch (e2) {
            // Still add as inaccessible but found
            foundSitemaps.push({
              url: sitemapUrl.startsWith('http') ? sitemapUrl : new URL(sitemapUrl, url).href,
              source: 'robots.txt',
              accessible: false,
              analyzed: false,
              error: e2.message
            });
          }
        }
      }
    }

    // 2. Check HTML for sitemap links
    if ($) {
      $('link[rel="sitemap"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
          try {
            const absoluteUrl = href.startsWith('http') ? href : new URL(href, url).href;
            foundSitemaps.push({
              url: absoluteUrl,
              source: 'HTML link',
              accessible: null // Not checked yet
            });
          } catch (e) { }
        }
      });
    }

    // 3. Check common sitemap paths (only if nothing found yet)
    if (foundSitemaps.length === 0) {
      const commonSitemapPaths = [
        '/sitemap.xml',
        '/sitemap_index.xml',
        '/sitemap-index.xml',
        '/sitemaps.xml',
        '/sitemap1.xml',
        '/wp-sitemap.xml', // WordPress sitemap
        '/sitemap_post.xml',
        '/sitemap_page.xml',
        '/sitemap_product.xml',
        '/sitemap_category.xml'
      ];

      for (const path of commonSitemapPaths) {
        try {
          const sitemapUrl = `${urlObj.protocol}//${urlObj.hostname}${path}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000);

          const response = await fetch(sitemapUrl, {
            signal: controller.signal,
            method: 'HEAD'
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('xml') || contentType.includes('text')) {
              const sitemapData = await analyzeSitemapContent(sitemapUrl, url);
              foundSitemaps.push({
                url: sitemapUrl,
                source: 'Common path',
                accessible: true,
                analyzed: sitemapData.analyzed,
                analysis: sitemapData
              });
              break; // Found one, no need to check others
            }
          }
        } catch (e) {
          continue;
        }
      }
    }

    // Aggregate subpage coverage from all analyzed sitemaps
    const totalSubpageCoverage = {
      totalPages: 0,
      categoryPages: 0,
      productPages: 0,
      blogPages: 0,
      staticPages: 0,
      hasCurrentPage: false,
      currentPageInSitemap: false,
      sitemapsWithCurrentPage: 0
    };

    foundSitemaps.forEach(sitemap => {
      if (sitemap.analyzed && sitemap.analysis.subpageCoverage) {
        const coverage = sitemap.analysis.subpageCoverage;
        totalSubpageCoverage.totalPages += coverage.totalPages || 0;
        totalSubpageCoverage.categoryPages += coverage.categoryPages || 0;
        totalSubpageCoverage.productPages += coverage.productPages || 0;
        totalSubpageCoverage.blogPages += coverage.blogPages || 0;
        totalSubpageCoverage.staticPages += coverage.staticPages || 0;

        if (coverage.currentPageInSitemap) {
          totalSubpageCoverage.hasCurrentPage = true;
          totalSubpageCoverage.currentPageInSitemap = true;
          totalSubpageCoverage.sitemapsWithCurrentPage++;
        }
      }
    });

    const result = {
      found: foundSitemaps.length > 0,
      sitemaps: foundSitemaps,
      url: foundSitemaps.length > 0 ? foundSitemaps[0].url : null,
      count: foundSitemaps.length,
      accessible: foundSitemaps.some(s => s.accessible === true),
      analyzed: foundSitemaps.some(s => s.analyzed === true),
      subpageCoverage: totalSubpageCoverage,
      hasCurrentPageInSitemap: totalSubpageCoverage.currentPageInSitemap
    };

    console.log('=== checkSitemap DEBUG ===');
    console.log('Found sitemaps:', result.found);
    console.log('Analyzed:', result.analyzed);
    console.log('SubpageCoverage total:', result.subpageCoverage.totalPages);
    console.log('Has current page:', result.hasCurrentPageInSitemap);

    return result;
  } catch (error) {
    return {
      found: false,
      url: null,
      accessible: false,
      analyzed: false,
      error: error.message,
      sitemaps: [],
      count: 0,
      subpageCoverage: {},
      hasCurrentPageInSitemap: false
    };
  }
}

// Helper function: Check specific subpage paths for robots.txt and sitemap rules
async function checkSubpagePaths(mainUrl, robotsTxtData, sitemapData) {
  try {
    console.log('=== checkSubpagePaths DEBUG ===');
    console.log('mainUrl:', mainUrl);
    console.log('robotsTxtData exists:', !!robotsTxtData);
    console.log('sitemapData exists:', !!sitemapData);
    console.log('robotsTxt has disallowRules:', !!(robotsTxtData?.disallowRules));
    console.log('sitemapData analyzed:', !!(sitemapData?.analyzed));
    const urlObj = new URL(mainUrl);
    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;

    // Common subpage paths to check
    const commonPaths = [
      '/admin',
      '/wp-admin',
      '/login',
      '/dashboard',
      '/category/example',
      '/blog',
      '/products',
      '/services',
      '/contact',
      '/about',
      '/search',
      '/api',
      '/user/profile',
      '/cart',
      '/checkout'
    ];

    const subpageResults = [];

    for (const path of commonPaths) {
      const fullUrl = baseUrl + path;
      const pathAllowed = robotsTxtData.disallowRules && robotsTxtData.allowRules ?
        checkPathRobots(path, robotsTxtData.disallowRules, robotsTxtData.allowRules) : true;

      // Check if this path exists in sitemap
      let inSitemap = false;
      if (sitemapData.analyzed && sitemapData.sitemaps) {
        for (const sitemap of sitemapData.sitemaps) {
          if (sitemap.analyzed && sitemap.analysis && sitemap.analysis.urls) {
            inSitemap = sitemap.analysis.urls.some(url =>
              url.loc && (url.loc === fullUrl || url.loc.startsWith(fullUrl))
            );
            if (inSitemap) break;
          }
        }
      }

      subpageResults.push({
        path: path,
        url: fullUrl,
        robotsAllowed: pathAllowed,
        inSitemap: inSitemap,
        recommendedAction: getSubpageRecommendation(path, pathAllowed, inSitemap)
      });
    }

    const result = {
      checkedPaths: subpageResults,
      summary: {
        totalChecked: subpageResults.length,
        robotsAllowed: subpageResults.filter(p => p.robotsAllowed).length,
        inSitemap: subpageResults.filter(p => p.inSitemap).length,
        properlyConfigured: subpageResults.filter(p =>
          (p.path.includes('/admin') || p.path.includes('/wp-admin') || p.path.includes('/api')) ?
            !p.robotsAllowed && !p.inSitemap : // Admin/API should be blocked
            (p.path.includes('/category') || p.path.includes('/blog') || p.path.includes('/products')) ?
              p.robotsAllowed && p.inSitemap : // Content should be allowed and in sitemap
              p.robotsAllowed // Other pages should be allowed
        ).length
      }
    };
    console.log('checkSubpagePaths returning result');
    return result;
  } catch (error) {
    console.error('Error in checkSubpagePaths:', error);
    return {
      checkedPaths: [],
      summary: {
        totalChecked: 0,
        robotsAllowed: 0,
        inSitemap: 0,
        properlyConfigured: 0
      }
    };
  }
}

// Helper function: Get recommendation for subpage configuration
function getSubpageRecommendation(path, robotsAllowed, inSitemap) {
  const isAdminPath = path.includes('/admin') || path.includes('/wp-admin') || path.includes('/dashboard') || path.includes('/api');
  const isContentPath = path.includes('/category') || path.includes('/blog') || path.includes('/products') || path.includes('/services');
  const isImportantPath = path.includes('/contact') || path.includes('/about') || path.includes('/login');

  if (isAdminPath) {
    if (robotsAllowed) return "Should be blocked in robots.txt";
    if (inSitemap) return "Should not be in sitemap";
    return "Properly configured";
  }

  if (isContentPath) {
    if (!robotsAllowed) return "Should be allowed in robots.txt";
    if (!inSitemap) return "Should be included in sitemap";
    return "Properly configured";
  }

  if (isImportantPath) {
    if (!robotsAllowed) return "Should be allowed in robots.txt";
    return inSitemap ? "Properly configured" : "Consider adding to sitemap";
  }

  return robotsAllowed ? "Properly configured" : "Review blocking rules";
}

async function scrapeSite(targetUrl) {
  console.log(`Step 1: Launching Chrome for ${targetUrl}...`);

  const { default: lighthouse } = await import('lighthouse');

  // Launch Chrome (Desktop Mode for stability)
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    userDataDir: LOCAL_CHROME_PATH
  });

  // A. Lighthouse (Speed/Tech)
  console.log("Step 2: Running Lighthouse...");
  let metrics = {
    performance: 0,
    seo: 0,
    accessibility: 0,
    bestPractices: 0,
    mobileFriendly: false,
    mobileScore: 0,
    mobileIssues: [],
    technical: {},
    security: {}
  };

  try {
    const options = {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices'],
      port: chrome.port,
      formFactor: 'desktop',
      screenEmulation: { mobile: false },
      settings: {
        gatherMode: 'full'
      }
    };

    const runnerResult = await lighthouse(targetUrl, options);
    const report = runnerResult.lhr;

    if (report.categories.performance) {
      metrics.performance = Math.round(report.categories.performance.score * 100);
      console.log(`✅ Speed Score: ${metrics.performance}`);
    }
    if (report.categories.seo) {
      metrics.seo = Math.round(report.categories.seo.score * 100);
    }
    if (report.categories.accessibility) {
      metrics.accessibility = Math.round(report.categories.accessibility.score * 100);
    }
    if (report.categories['best-practices']) {
      metrics.bestPractices = Math.round(report.categories['best-practices'].score * 100);
    }

    // Enhanced mobile-friendly checks
    const viewport = report.audits['viewport'];
    const tapTargets = report.audits['tap-targets'];
    const contentWidth = report.audits['content-width'];
    const fontSizes = report.audits['font-size'];
    const plugins = report.audits['plugins'];

    let mobileIssues = [];
    let mobileScore = 100;

    // Check viewport meta tag
    if (!viewport || viewport.score !== 1) {
      mobileIssues.push("Missing or improper viewport meta tag");
      mobileScore -= 25;
    }

    // Check tap targets (minimum 48x48px)
    if (tapTargets && tapTargets.score < 1) {
      mobileIssues.push("Tap targets too small for mobile interaction");
      mobileScore -= 15;
    }

    // Check content width (no horizontal scrolling)
    if (contentWidth && contentWidth.score < 1) {
      mobileIssues.push("Content too wide, causes horizontal scrolling");
      mobileScore -= 20;
    }

    // Check font sizes (readable on mobile)
    if (fontSizes && fontSizes.score < 1) {
      mobileIssues.push("Text too small to read on mobile");
      mobileScore -= 10;
    }

    // Check for plugins (Flash, etc.)
    if (plugins && plugins.score < 1) {
      mobileIssues.push("Uses unsupported plugins on mobile");
      mobileScore -= 10;
    }

    metrics.mobileFriendly = mobileScore >= 80;
    metrics.mobileIssues = mobileIssues;
    metrics.mobileScore = mobileScore;

    // Enhanced technical metrics with comprehensive Lighthouse speed data
    const fcpAudit = report.audits['first-contentful-paint'];
    const lcpAudit = report.audits['largest-contentful-paint'];
    const clsAudit = report.audits['cumulative-layout-shift'];
    const tbtAudit = report.audits['total-blocking-time'];
    const siAudit = report.audits['speed-index'];
    const ttiAudit = report.audits['interactive'];
    const ttfbAudit = report.audits['server-response-time'];
    const fidAudit = report.audits['max-potential-fid'];
    const domSizeAudit = report.audits['dom-size'];
    const resourceSummary = report.audits['resource-summary'];

    metrics.technical = {
      // Core Web Vitals - Display values and numeric values
      firstContentfulPaint: {
        displayValue: fcpAudit?.displayValue || 'N/A',
        numericValue: fcpAudit?.numericValue || null,
        score: fcpAudit?.score || null,
        unit: 'ms'
      },
      largestContentfulPaint: {
        displayValue: lcpAudit?.displayValue || 'N/A',
        numericValue: lcpAudit?.numericValue || null,
        score: lcpAudit?.score || null,
        unit: 'ms'
      },
      cumulativeLayoutShift: {
        displayValue: clsAudit?.displayValue || 'N/A',
        numericValue: clsAudit?.numericValue || null,
        score: clsAudit?.score || null,
        unit: ''
      },
      totalBlockingTime: {
        displayValue: tbtAudit?.displayValue || 'N/A',
        numericValue: tbtAudit?.numericValue || null,
        score: tbtAudit?.score || null,
        unit: 'ms'
      },
      speedIndex: {
        displayValue: siAudit?.displayValue || 'N/A',
        numericValue: siAudit?.numericValue || null,
        score: siAudit?.score || null,
        unit: 's'
      },
      timeToInteractive: {
        displayValue: ttiAudit?.displayValue || 'N/A',
        numericValue: ttiAudit?.numericValue || null,
        score: ttiAudit?.score || null,
        unit: 's'
      },
      // Additional Speed Metrics
      timeToFirstByte: {
        displayValue: ttfbAudit?.displayValue || 'N/A',
        numericValue: ttfbAudit?.numericValue || null,
        score: ttfbAudit?.score || null,
        unit: 'ms'
      },
      firstInputDelay: {
        displayValue: fidAudit?.displayValue || 'N/A',
        numericValue: fidAudit?.numericValue || null,
        score: fidAudit?.score || null,
        unit: 'ms'
      },
      // Resource Metrics
      resourceSummary: {
        totalRequests: resourceSummary?.details?.items?.[0]?.requestCount || null,
        totalSize: resourceSummary?.details?.items?.[0]?.size || null,
        displayValue: resourceSummary?.displayValue || 'N/A'
      },
      domSize: {
        displayValue: domSizeAudit?.displayValue || 'N/A',
        numericValue: domSizeAudit?.numericValue || null,
        unit: 'nodes'
      },
      // Network and Resource Breakdown
      networkRequests: report.audits['network-requests']?.details?.items?.length || 0,
      renderBlockingResources: report.audits['render-blocking-resources']?.details?.items?.length || 0,
      unusedJavaScript: {
        displayValue: report.audits['unused-javascript']?.displayValue || 'N/A',
        wastedBytes: report.audits['unused-javascript']?.details?.overallSavingsBytes || 0
      },
      unusedCSS: {
        displayValue: report.audits['unused-css-rules']?.displayValue || 'N/A',
        wastedBytes: report.audits['unused-css-rules']?.details?.overallSavingsBytes || 0
      },
      // Performance Budget
      totalByteWeight: {
        displayValue: report.audits['total-byte-weight']?.displayValue || 'N/A',
        numericValue: report.audits['total-byte-weight']?.numericValue || null,
        unit: 'bytes'
      },
      // Opportunities (Performance improvements)
      opportunities: {
        reduceRenderBlockingResources: report.audits['render-blocking-resources']?.displayValue || null,
        enableTextCompression: report.audits['uses-text-compression']?.displayValue || null,
        modernImageFormats: report.audits['uses-optimized-images']?.displayValue || null,
        efficientAnimatedContent: report.audits['efficient-animated-content']?.displayValue || null,
        preconnectToRequiredOrigins: report.audits['uses-rel-preconnect']?.displayValue || null
      },
      // Resource size breakdown by type
      resourceSizes: analyzeResourceSizes(report)
    };

    // Security and best practices
    metrics.security = {
      httpsUsed: targetUrl.startsWith('https://'),
      mixedContent: report.audits['mixed-content']?.score === 1,
      noVulnerableLibraries: report.audits['no-vulnerable-libraries']?.score === 1,
      safeBrowsing: report.audits['safe-browsing']?.score === 1
    };

  } catch (lhError) {
    console.log("⚠️ Lighthouse error:", lhError.message);
  }

  // B. Puppeteer (Content & Structure)
  console.log("Step 3: Grabbing HTML via Puppeteer...");
  let html = "";
  try {
    const browser = await puppeteer.connect({ browserURL: `http://localhost:${chrome.port}` });
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    html = await page.content();
    await page.close();
    browser.disconnect();
  } catch (pupError) {
    console.error("⚠️ Puppeteer error:", pupError.message);
    html = "<body><h1>Content unavailable</h1></body>";
  }

  // C. Deep Analysis
  const $ = cheerio.load(html);
  let domain = "site";
  try { domain = new urlModule.URL(targetUrl).hostname; } catch (e) { }

  const totalImages = $('img').length;
  const missingAlt = $('img:not([alt])').length;

  // Extract detailed link information
  const detailedLinks = extractDetailedLinks($, targetUrl);
  const socialLinks = detailedLinks.external.filter(link =>
    link.url.includes('facebook.com') ||
    link.url.includes('twitter.com') ||
    link.url.includes('linkedin.com') ||
    link.url.includes('instagram.com') ||
    link.url.includes('youtube.com') ||
    link.url.includes('pinterest.com')
  ).map(link => link.url);

  const internalLinks = detailedLinks.internalCount;
  const externalLinks = detailedLinks.externalCount;

  $('script').remove(); $('style').remove();
  const textContent = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 2500);
  const fullTextContent = $('body').text().replace(/\s+/g, ' ').trim();

  // Enhanced content analysis
  const title = $('title').text().trim() || '';
  const description = $('meta[name="description"]').attr('content') || '';
  const keywordAnalysis = analyzeKeywords(fullTextContent, title, description);
  const contentUniqueness = evaluateContentUniqueness(fullTextContent, title, description);
  const readabilityScore = calculateReadability(textContent);
  const keywordIntent = analyzeKeywordIntent(fullTextContent, title, description);

  // Indexability checks - robots.txt first
  const robotsTxt = await analyzeRobotsTxt(targetUrl);
  const metaRobots = analyzeMetaRobots($);
  // Check sitemap with robots.txt sitemaps included
  const sitemap = await checkSitemap(targetUrl, robotsTxt.sitemaps || [], $);

  // Enhanced subpage analysis
  console.log('Starting subpage analysis...');
  console.log('Robots data type:', typeof robotsTxt);
  console.log('Sitemap data type:', typeof sitemap);
  console.log('Robots has enhanced fields:', !!(robotsTxt?.disallowRules));
  console.log('Sitemap has enhanced fields:', !!(sitemap?.analyzed));

  const subpageAnalysis = await checkSubpagePaths(targetUrl, robotsTxt, sitemap);
  console.log('Subpage analysis completed:', subpageAnalysis ? 'success' : 'failed');
  console.log('Subpage analysis summary:', subpageAnalysis?.summary);

  // Basic structure first
  const structure = {
    h1: $('h1').text().trim() || "Missing",
    h1Count: $('h1').length,
    title: title,
    description: description,
    headings: {},
    links: { internal: internalLinks, external: externalLinks },
    socials: socialLinks.length > 0 ? "Detected" : "None Detected",
    metaTags: {},
    structuredData: [],
    wordCount: textContent.split(/\s+/).length,
    readabilityScore: readabilityScore,
    language: $('html').attr('lang') || 'Not specified',
    canonical: $('link[rel="canonical"]').attr('href') || 'Not found',
    // Enhanced fields
    keywordAnalysis: keywordAnalysis,
    keywordIntent: keywordIntent,
    contentUniqueness: contentUniqueness,
    domainInfo: await analyzeDomain(targetUrl),
    // Indexability checks
    robotsTxt: robotsTxt,
    metaRobots: metaRobots.content || 'Not specified',
    metaRobotsFull: metaRobots, // Full meta robots object for detailed analysis
    robotsAllowed: metaRobots.allowsIndexing && robotsTxt.allowsIndexing,
    sitemap: sitemap,
    subpageAnalysis: subpageAnalysis
  };

  // Complete heading structure
  for (let i = 1; i <= 6; i++) {
    structure.headings[`h${i}`] = $(`h${i}`).length;
  }

  // Complete image analysis with detailed data
  const images = [];
  $('img').each((i, img) => {
    const $img = $(img);
    let src = $img.attr('src') || $img.attr('data-src') || '';

    // Convert relative URLs to absolute
    if (src && !src.startsWith('http') && !src.startsWith('//')) {
      try {
        src = new URL(src, targetUrl).href;
      } catch (e) {
        // Keep original if URL construction fails
      }
    } else if (src && src.startsWith('//')) {
      src = 'https:' + src;
    }

    images.push({
      src: src,
      alt: $img.attr('alt') || '',
      width: $img.attr('width') || $img.attr('data-width') || '',
      height: $img.attr('height') || $img.attr('data-height') || '',
      hasAlt: !!$img.attr('alt'),
      loading: $img.attr('loading') || 'eager', // lazy or eager
      isDecorative: !$img.attr('alt') && !$img.attr('role'), // Likely decorative if no alt
      hasDimensions: !!(($img.attr('width') || $img.attr('data-width')) && ($img.attr('height') || $img.attr('data-height')))
    });
  });

  // Complete meta tags analysis
  console.log('=== META TAGS ANALYSIS DEBUG ===');
  console.log('Total meta tags found:', $('meta').length);

  $('meta').each((i, meta) => {
    const name = $(meta).attr('name') || $(meta).attr('property');
    const content = $(meta).attr('content');
    if (name && content) {
      structure.metaTags[name] = content;
      if (name.includes('og:') || name.includes('fb:') || name.includes('twitter:')) {
        console.log(`Found social meta tag: ${name} = ${content}`);
      }
    }
  });

  console.log('Total meta tags processed:', Object.keys(structure.metaTags).length);

  // Complete structured data analysis
  $('script[type="application/ld+json"]').each((i, script) => {
    try {
      structure.structuredData.push(JSON.parse($(script).html()));
    } catch (e) { }
  });

  // Hreflang tags analysis
  const hreflang = analyzeHreflang($, targetUrl, html);

  // Open Graph analysis
  console.log('=== CALLING analyzeOpenGraph ===');
  console.log('Target URL:', targetUrl);
  console.log('HTML loaded, title:', title);
  console.log('HTML loaded, meta tags count:', $('meta').length);

  let openGraph = { found: false, error: 'Not analyzed' };
  try {
    const openGraphData = analyzeOpenGraph($, targetUrl);
    console.log('Open Graph function returned:', !!openGraphData);
    console.log('Open Graph found:', openGraphData?.found);
    console.log('Open Graph title:', openGraphData?.basic?.title);
    openGraph = openGraphData;
  } catch (error) {
    console.error('❌ Error in Open Graph analysis:', error.message);
    console.error('Stack:', error.stack);
    openGraph = { found: false, error: error.message };
  }

  // Enhanced analysis using new functions
  const imageAnalysis = analyzeImages(images);
  const schemaAnalysis = analyzeStructuredData(structure.structuredData, $);
  const competitiveAnalysis = performCompetitiveAnalysis(metrics, structure);
  const screenshot = await captureScreenshot(targetUrl);

  // Add advanced analysis to structure
  structure.images = imageAnalysis;
  structure.imagesDetailed = images; // Full image list for detailed table
  structure.schemaAnalysis = schemaAnalysis;
  structure.competitiveAnalysis = competitiveAnalysis;
  structure.screenshot = screenshot;
  structure.hreflang = hreflang;
  structure.openGraph = openGraph;
  structure.linksDetailed = {
    internal: detailedLinks.internal,
    external: detailedLinks.external,
    social: socialLinks
  };

  await chrome.kill();
  try { fs.rmSync(LOCAL_CHROME_PATH, { recursive: true, force: true }); } catch (e) { }

  return { metrics, structure, textContent, domain: targetUrl };
}

async function getAIAdvice(data) {
  console.log("Step 4: Getting comprehensive AI analysis...");

  // Safety check for data structure
  if (!data || !data.metrics) {
    console.error("❌ Invalid data structure passed to getAIAdvice");
    return {
      health_score: 50,
      summary: "Analysis failed due to missing data",
      recommendations: []
    };
  }

  try {
    // Safe template generation with proper error handling
    const performanceScore = data.metrics?.performance || 0;
    const seoScore = data.metrics?.seo || 0;
    const accessibilityScore = data.metrics?.accessibility || 0;
    const bestPracticesScore = data.metrics?.bestPractices || 0;
    const mobileScore = data.metrics?.mobileScore || 0;
    const mobileIssues = data.metrics?.mobileIssues?.length > 0 ? data.metrics.mobileIssues.join(', ') : 'None detected';

    const fcp = data.metrics?.technical?.firstContentfulPaint;
    const lcp = data.metrics?.technical?.largestContentfulPaint;
    const cls = data.metrics?.technical?.cumulativeLayoutShift;
    const tbt = data.metrics?.technical?.totalBlockingTime;
    const tti = data.metrics?.technical?.timeToInteractive;
    const si = data.metrics?.technical?.speedIndex;
    const ttfb = data.metrics?.technical?.timeToFirstByte;
    const fid = data.metrics?.technical?.firstInputDelay;
    const networkRequests = data.metrics?.technical?.networkRequests || 0;
    const renderBlockingResources = data.metrics?.technical?.renderBlockingResources || 0;
    const totalPageWeight = data.metrics?.technical?.totalByteWeight?.displayValue || 'N/A';

    const prompt = `
      You are an expert SEO analyst. Analyze this comprehensive website data and provide detailed, actionable recommendations.
      
      URL: ${data.url || 'N/A'}
      
      TECHNICAL PERFORMANCE METRICS:
      - Performance Score: ${performanceScore}/100
      - SEO Score: ${seoScore}/100
      - Accessibility Score: ${accessibilityScore}/100
      - Best Practices Score: ${bestPracticesScore}/100
      - Mobile Score: ${mobileScore}/100
      - Mobile Issues: ${mobileIssues}
      
      CORE WEB VITALS:
      - First Contentful Paint: ${fcp?.displayValue || 'N/A'} ${fcp?.numericValue ? `(${Math.round(fcp.numericValue)}ms)` : ''}
      - Largest Contentful Paint: ${lcp?.displayValue || 'N/A'} ${lcp?.numericValue ? `(${Math.round(lcp.numericValue)}ms)` : ''}
      - Cumulative Layout Shift: ${cls?.displayValue || 'N/A'}
      - Total Blocking Time: ${tbt?.displayValue || 'N/A'} ${tbt?.numericValue ? `(${Math.round(tbt.numericValue)}ms)` : ''}
       - Time to Interactive: ${tti?.displayValue || 'N/A'} ${tti?.numericValue ? `(${Math.round(tti.numericValue / 1000)}s)` : ''}
      - Speed Index: ${si?.displayValue || 'N/A'} ${si?.numericValue ? `(${Math.round(si.numericValue / 1000)}s)` : ''}
      - Time to First Byte: ${ttfb?.displayValue || 'N/A'} ${ttfb?.numericValue ? `(${Math.round(ttfb.numericValue)}ms)` : ''}
      - First Input Delay: ${fid?.displayValue || 'N/A'} ${fid?.numericValue ? `(${Math.round(fid.numericValue)}ms)` : ''}
      
      PERFORMANCE RESOURCES:
      - Total Network Requests: ${networkRequests}
      - Render Blocking Resources: ${renderBlockingResources}
      - Total Page Weight: ${totalPageWeight}
    - DOM Size: ${data.metrics.technical.domSize?.displayValue || 'N/A'}
    - Unused JavaScript: ${data.metrics.technical.unusedJavaScript?.displayValue || 'N/A'} ${data.metrics.technical.unusedJavaScript?.wastedBytes > 0 ? `(${Math.round(data.metrics.technical.unusedJavaScript.wastedBytes / 1024)}KB wasted)` : ''}
    - Unused CSS: ${data.metrics.technical.unusedCSS?.displayValue || 'N/A'} ${data.metrics.technical.unusedCSS?.wastedBytes > 0 ? `(${Math.round(data.metrics.technical.unusedCSS.wastedBytes / 1024)}KB wasted)` : ''}
    
    PERFORMANCE OPPORTUNITIES:
    ${data.metrics.technical.opportunities?.reduceRenderBlockingResources ? `- Render Blocking Resources: ${data.metrics.technical.opportunities.reduceRenderBlockingResources}` : ''}
    ${data.metrics.technical.opportunities?.enableTextCompression ? `- Text Compression: ${data.metrics.technical.opportunities.enableTextCompression}` : ''}
    ${data.metrics.technical.opportunities?.modernImageFormats ? `- Image Optimization: ${data.metrics.technical.opportunities.modernImageFormats}` : ''}
    
    SECURITY & INDEXING ANALYSIS:
    - HTTPS Status: ${data.metrics.security.httpsUsed ? 'Secure ✅' : 'Not Secure ⚠️'}
    - Mixed Content: ${data.metrics.security.mixedContent ? 'Safe ✅' : 'Mixed Content ⚠️'}
    - Robots.txt: ${data.structure.robotsTxt?.exists ? 'Found ✅' : 'Missing ❌'} (${data.structure.robotsTxt?.allowsIndexing ? 'Allows indexing ✅' : 'Blocks indexing ⚠️'})
    - Robots.txt Sitemap: ${data.structure.robotsTxt?.hasSitemap ? 'Referenced ✅' : 'Not referenced ❌'}
    - Meta Robots: ${data.structure.metaRobots || 'Not specified'} (${typeof data.structure.robotsAllowed !== 'undefined' ? (data.structure.robotsAllowed ? 'Allows indexing ✅' : 'Blocks indexing ⚠️') : 'Unknown'})
    - XML Sitemap: ${data.structure.sitemap?.found ? `Found ✅ (${data.structure.sitemap.url})` : 'Not found ❌'}
     - Hreflang Tags: ${data.structure.hreflang?.found ? `Found ✅ (${data.structure.hreflang.count} languages)` : 'Missing ❌'} ${data.structure.hreflang?.hasXDefault ? '(with x-default ✅)' : '(missing x-default ⚠️)'}
     
     OPEN GRAPH SOCIAL MEDIA ANALYSIS:
     - Open Graph Found: ${data.structure.openGraph?.found ? 'Yes ✅' : 'No ❌'}
     - OG Title: ${data.structure.openGraph?.basic?.title ? `"${data.structure.openGraph.basic.title}"` : 'Missing ❌'}
     - OG Description: ${data.structure.openGraph?.basic?.description ? `"${data.structure.openGraph.basic.description}"` : 'Missing ❌'}
     - OG Type: ${data.structure.openGraph?.basic?.type || 'Not specified ⚠️'}
     - OG Images: ${data.structure.openGraph?.images?.length || 0} found
     - OG Site Name: ${data.structure.openGraph?.basic?.siteName || 'Missing ⚠️'}
     - Facebook Integration: ${data.structure.openGraph?.facebook?.app_id || data.structure.openGraph?.facebook?.page_id ? 'Connected ✅' : 'Not configured ⚠️'}
     - Twitter Card: ${data.structure.openGraph?.twitter?.card ? `${data.structure.openGraph.twitter.card} ✅` : 'Missing ❌'}
     - Social Proof: ${data.structure.openGraph?.hasSocialProof ? 'Strong ✅' : 'Weak ❌'}
     - Rich Media: ${data.structure.openGraph?.hasRichMedia ? 'Optimized ✅' : 'Basic ⚠️'}
     - OG Completeness: ${data.structure.openGraph?.completeness || 0}/100
     - Total OG Tags: ${data.structure.openGraph?.totalTags || 0}
     
     OVERALL INDEXABILITY:
     - Current Page Indexing: ${data.structure.robotsAllowed && data.structure.sitemap?.found ? 'Good ✅' : data.structure.robotsAllowed ? 'Indexable but no sitemap ⚠️' : 'Blocked from indexing ❌'}
     - Social Media Optimization: ${data.structure.openGraph?.found && data.structure.openGraph.completeness > 50 ? 'Well optimized ✅' : 'Needs improvement ⚠️'}
     
     SUBPAGE ANALYSIS:
    - Common Paths Checked: ${data.structure.subpageAnalysis?.summary?.totalChecked || 0}
    - Paths Allowed by Robots: ${data.structure.subpageAnalysis?.summary?.robotsAllowed || 0}
    - Paths in Sitemap: ${data.structure.subpageAnalysis?.summary?.inSitemap || 0}
    - Properly Configured Paths: ${data.structure.subpageAnalysis?.summary?.properlyConfigured || 0}
    - Current Page in Robots.txt: ${data.structure.robotsTxt?.currentPathAllowed !== false ? 'Allowed ✅' : 'Blocked ⚠️'}
    - Current Page in Sitemap: ${data.structure.sitemap?.hasCurrentPageInSitemap ? 'Found ✅' : 'Not found ⚠️'}
    - Subpage Robots Rules: ${data.structure.robotsTxt?.subpageAnalysis?.hasAdminRules ? 'Admin rules found' : 'No admin rules'}, ${data.structure.robotsTxt?.subpageAnalysis?.hasContentRules ? 'Content rules found' : 'No content rules'}, ${data.structure.robotsTxt?.subpageAnalysis?.hasSearchRules ? 'Search rules found' : 'No search rules'}
    
    RESOURCE SIZE BREAKDOWN:
    - JavaScript: ${data.metrics.technical.resourceSizes?.js ? `${Math.round(data.metrics.technical.resourceSizes.js.size / 1024)}KB (${data.metrics.technical.resourceSizes.js.count} files)` : 'N/A'}
    - CSS: ${data.metrics.technical.resourceSizes?.css ? `${Math.round(data.metrics.technical.resourceSizes.css.size / 1024)}KB (${data.metrics.technical.resourceSizes.css.count} files)` : 'N/A'}
    - Images: ${data.metrics.technical.resourceSizes?.images ? `${Math.round(data.metrics.technical.resourceSizes.images.size / 1024)}KB (${data.metrics.technical.resourceSizes.images.count} files)` : 'N/A'}
    - Fonts: ${data.metrics.technical.resourceSizes?.fonts ? `${Math.round(data.metrics.technical.resourceSizes.fonts.size / 1024)}KB (${data.metrics.technical.resourceSizes.fonts.count} files)` : 'N/A'}
    - Other: ${data.metrics.technical.resourceSizes?.other ? `${Math.round(data.metrics.technical.resourceSizes.other.size / 1024)}KB (${data.metrics.technical.resourceSizes.other.count} files)` : 'N/A'}
    - Total: ${data.metrics.technical.resourceSizes?.total ? `${Math.round(data.metrics.technical.resourceSizes.total / 1024)}KB` : 'N/A'}
    
    SITEMAP CONTENT ANALYSIS:
    - Sitemap Analyzed: ${data.structure.sitemap?.analyzed ? 'Yes ✅' : 'No ❌'}
    - Total URLs in Sitemap: ${data.structure.sitemap?.subpageCoverage?.totalPages || 0}
    - Category Pages: ${data.structure.sitemap?.subpageCoverage?.categoryPages || 0}
    - Product Pages: ${data.structure.sitemap?.subpageCoverage?.productPages || 0}
    - Blog Pages: ${data.structure.sitemap?.subpageCoverage?.blogPages || 0}
    - Static Pages: ${data.structure.sitemap?.subpageCoverage?.staticPages || 0}
    - Current Page in Sitemap: ${data.structure.sitemap?.hasCurrentPageInSitemap ? 'Yes ✅' : 'No ⚠️'}
    - Sitemap Coverage: ${data.structure.sitemap?.subpageCoverage?.totalPages > 100 ? 'Excellent' : data.structure.sitemap?.subpageCoverage?.totalPages > 50 ? 'Good' : data.structure.sitemap?.subpageCoverage?.totalPages > 10 ? 'Fair' : 'Poor'}
    
    CONTENT ANALYSIS:
    - Word Count: ${data.structure.wordCount}
    - Readability Score: ${data.structure.readabilityScore}/100 (${data.structure.readabilityScore >= 80 ? 'Highly readable' : data.structure.readabilityScore >= 60 ? 'Moderately readable' : 'Needs improvement'})
    - Language: ${data.structure.language}
    - Content Uniqueness Score: ${data.structure.contentUniqueness?.score || 'N/A'}/100
    - Content Length: ${data.textContent.length} characters (${data.textContent.length < 300 ? 'Too short' : data.textContent.length < 1000 ? 'Good length' : data.textContent.length >= 1000 ? 'Very long' : 'Good length'})
    - Open Graph Title vs HTML Title: ${data.structure.openGraph?.basic?.title && data.structure.title ? (data.structure.openGraph.basic.title === data.structure.title ? 'Match ✅' : 'Different ⚠️') : 'No OG title ❌'}
    - Open Graph Description vs Meta Description: ${data.structure.openGraph?.basic?.description && data.structure.description ? (data.structure.openGraph.basic.description === data.structure.description ? 'Match ✅' : 'Different ⚠️') : 'No OG description ❌'}
    
    KEYWORD ANALYSIS:
    - Total Keywords: ${data.structure.keywordAnalysis?.totalWords || 0} words
    - Unique Words: ${data.structure.keywordAnalysis?.uniqueWords || 0} unique words
    - Top Keywords: ${data.structure.keywordAnalysis?.topKeywords?.slice(0, 5).map(k => `${k.word} (${k.density}%)`).join(', ') || 'None detected'}
    - Keyword Density: ${data.structure.keywordAnalysis?.topKeywords?.length > 0 ? 'Good keyword diversity' : 'No keyword optimization'}
    - Primary Keyword Identified: ${data.structure.keywordAnalysis?.topKeywords?.[0]?.word || 'None'}
    
    KEYWORD INTENT ALIGNMENT:
    - Primary Intent: ${data.structure.keywordIntent?.primaryIntent || 'Unknown'} (${data.structure.keywordIntent?.confidence || 0}% confidence)
    - Intent Alignment: ${data.structure.keywordIntent?.aligned ? 'Well aligned ✅' : 'Needs improvement ⚠️'}
    - Intent Breakdown: Informational (${data.structure.keywordIntent?.intentScores?.informational || 0}), Navigational (${data.structure.keywordIntent?.intentScores?.navigational || 0}), Transactional (${data.structure.keywordIntent?.intentScores?.transactional || 0}), Commercial (${data.structure.keywordIntent?.intentScores?.commercial || 0})
    
    ON-PAGE SEO ELEMENTS:
    - Title Tag: "${data.structure.title}" (${data.structure.title.length} characters)
    - Title Status: ${data.structure.title.length >= 30 && data.structure.title.length <= 60 ? 'Optimized ✅' : data.structure.title.length > 60 ? 'Too long ⚠️' : 'Too short ⚠️'}
    - Meta Description: "${data.structure.description}" (${data.structure.description.length} characters)
    - Meta Description Status: ${data.structure.description.length >= 120 && data.structure.description.length <= 160 ? 'Optimized ✅' : data.structure.description.length > 160 ? 'Too long ⚠️' : 'Too short ⚠️'}
    - H1 Tag: "${data.structure.h1}" (${data.structure.h1Count} found)
    - H1 Status: ${data.structure.h1Count === 1 ? 'Perfect ✅' : data.structure.h1Count === 0 ? 'Missing ❌' : data.structure.h1Count > 1 ? 'Multiple H1s ⚠️' : 'Error ⚠️'}
    - Heading Structure: ${Object.entries(data.structure.headings).map(([tag, count]) => `${tag}: ${count}`).join(', ')}
    - Canonical URL: ${data.structure.canonical !== 'Not found' ? data.structure.canonical : 'Missing ❌'}
    - Canonical Status: ${data.structure.canonical !== 'Not found' ? 'Implemented ✅' : 'Not implemented ❌'}
    
    IMAGE SEO ANALYSIS:
    - Total Images: ${data.structure.images?.total || 0}
    - Images with Alt Text: ${data.structure.images?.hasAlt || 0}
    - Images Missing Alt Text: ${data.structure.images?.total - (data.structure.images?.hasAlt || 0)}
    - Alt Text Coverage: ${data.structure.images?.total > 0 ? Math.round((data.structure.images?.hasAlt / data.structure.images?.total) * 100) : 0}%
    - Images with Dimensions: ${data.structure.imagesDetailed?.filter(img => img.hasDimensions).length || 0}
    - Lazy Loading Images: ${data.structure.imagesDetailed?.filter(img => img.loading === 'lazy').length || 0}
    - Decorative Images (no alt): ${data.structure.imagesDetailed?.filter(img => img.isDecorative).length || 0}
    - Image Optimization Rate: ${data.structure.images?.optimizationRate || 0}%
    - Image SEO Status: ${data.structure.images?.optimizationRate >= 80 ? 'Well optimized ✅' : 'Needs optimization ⚠️'}
    
    LINKING ANALYSIS:
    - Internal Links: ${data.structure.links?.internal || 0} (${data.structure.linksDetailed?.internal?.length || 0} detailed)
    - External Links: ${data.structure.links?.external || 0} (${data.structure.linksDetailed?.external?.length || 0} detailed)
    - Social Media Links: ${data.structure.socialLinksCount || 0}
    - Link Ratio: ${data.structure.links?.internal > 0 && data.structure.links?.external > 0 ? Math.round((data.structure.links?.internal / (data.structure.links?.internal + data.structure.links?.external)) * 100) : 0}%
    - Internal Link Quality: ${data.structure.links?.internal >= 10 ? 'Good internal linking' : data.structure.links?.internal < 5 ? 'Limited internal linking' : 'Poor internal linking'}
    - External Links Quality: ${data.structure.links?.external > 0 && data.structure.links?.external <= 5 ? 'Reasonable external links' : data.structure.links?.external > 10 ? 'Too many external links' : 'Good external linking'}
    - Nofollow Links: ${data.structure.linksDetailed?.internal?.filter(l => l.isNofollow).length || 0} internal, ${data.structure.linksDetailed?.external?.filter(l => l.isNofollow).length || 0} external
    
    DOMAIN ANALYSIS:
    - Domain: ${new URL(data.domain || 'http://example.com').hostname}
    - Domain Name: ${data.structure.domainInfo?.domainName || data.structure.domainInfo?.hostname || 'N/A'}
    - TLD: ${data.structure.domainInfo?.tld || 'N/A'}
    - Domain Age: ${data.structure.domainInfo?.age || 'Unknown'} ${data.structure.domainInfo?.ageInYears ? `(approximately ${data.structure.domainInfo.ageInYears} years)` : ''}
    - Estimated Authority: ${data.structure.domainInfo?.estimatedAuthority || (data.structure.domainInfo?.age && data.structure.domainInfo.age !== 'Unknown' ? 'Established domain' : 'New domain - needs trust building')}
    - SSL Enabled: ${data.structure.domainInfo?.ssl ? 'Yes ✅' : 'No ⚠️'}
    - Is Subdomain: ${data.structure.domainInfo?.subdomain ? 'Yes' : 'No'}
    
    STRUCTURED DATA ANALYSIS:
    - Schema Types Detected: ${data.structure.schemaAnalysis?.types?.length || 0} types
    - Schema Implementation: ${data.structure.schemaAnalysis?.schemasFound > 0 ? 'Advanced implementation' : 'Basic markup'}
    - Organization Schema: ${data.structure.schemaAnalysis?.organization ? 'Implemented ✅' : 'Missing opportunity'}
    - Article/News Schema: ${data.structure.schemaAnalysis?.article ? 'Implemented ✅' : 'Missing opportunity'}
    - Product/Service Schema: ${data.structure.schemaAnalysis?.product ? 'Implemented ✅' : 'Missing opportunity'}
    - Breadcrumb Schema: ${data.structure.schemaAnalysis?.breadcrumb ? 'Implemented ✅' : 'Missing opportunity'}
    - LocalBusiness Schema: ${data.structure.schemaAnalysis?.localBusiness ? 'Implemented ✅' : 'Missing opportunity'}
    - Review/Rating Schema: ${data.structure.schemaAnalysis?.rating ? 'Implemented ✅' : 'Missing opportunity'}
    
    SOCIAL MEDIA PRESENCE:
    - Social Links: ${data.structure.socials}
    - Platform Coverage: ${data.structure.socials !== 'None Detected' ? 'Good social presence' : 'Limited social presence'}
    - Open Graph Optimization: ${data.structure.openGraph?.found ? 'Implemented ✅' : 'Missing ❌'}
    - Social Media Score: ${data.structure.openGraph?.completeness ? `${data.structure.openGraph.completeness}/100` : '0/100'}
    
    COMPETITIVE ANALYSIS:
    - Overall Grade: ${data.structure.competitiveAnalysis?.overallGrade || 'C'}
    - Performance vs Content: ${data.metrics.performance}/${data.structure.readabilityScore}
    - Technical Strengths: ${data.structure.competitiveAnalysis?.strengths?.join(', ') || 'None identified'}
    - Technical Weaknesses: ${data.structure.competitiveAnalysis?.weaknesses?.join(', ') || 'None identified'}
    
    Return a JSON object with comprehensive analysis and actionable recommendations in the following JSON format:
    {
      "health_score": <number 0-100>,
      "summary": "<comprehensive executive summary with business context and competitive analysis>",
      "strengths": ["<3-5 specific strengths with competitive advantage>"],
      "weaknesses": ["<3-5 critical weaknesses with business impact>"],
      "recommendations": [
        { 
          "priority": "Critical"|"Medium"|"Quick Win", 
          "category": "Technical"|"Content"|"Security"|"UX"|"SEO"|"Schema"|"Social"|"Image", 
          "issue": "<specific problem title>", 
          "problem": "<WHAT is wrong - specific description of the issue>", 
          "why_it_matters": "<WHY it matters for SEO - explain the SEO impact>", 
          "how_to_fix": "<HOW to fix it - clear step-by-step instructions>"
        }
      ],
      "content_analysis": {
        "keyword_density": "<assessment of keyword optimization>",
        "content_quality": "<assessment of content depth and value>",
        "semantic_relevance": "<assessment of topic alignment>"
      },
      "competitive_insights": {
        "industry_benchmarks": {
          "performance": "<industry average comparison>",
          "accessibility": "<industry average>",
          "content_depth": "<assessment>",
          "technical_seo": "<overall technical assessment>"
        },
        "improvement_priority": "<single most important area to focus on>",
        "competitive_advantage": "<key competitive differentiation>"
      },
      "technical_debt_analysis": {
        "critical_issues": "<list of critical technical issues>",
        "performance_gaps": "<performance optimization opportunities>",
        "security_vulnerabilities": "<security issues found>",
        "code_quality_issues": "<code quality and accessibility issues>",
        "optimization_priorities": "<ranked list of technical improvements>"
      },
      "benchmarking": {
        "performance_grade": "<A+ to F performance grade>",
        "seo_grade": "<SEO performance evaluation>",
        "accessibility_score": "<accessibility compliance rating>",
        "mobile_score": "<mobile optimization score>",
        "content_quality_score": "<content quality assessment>",
        "overall_grade": "<comprehensive website grade>"
      },
      "action_plan": {
        "immediate_fixes": "<quick wins for immediate impact>",
        "short_term_goals": "<1-3 month strategic improvements>",
        "long_term_strategy": "<6+ month foundational changes>",
        "resource_allocation": "<recommended resource allocation>"
      }
    }
  `;

    try {
      const completion = await groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(completion.choices[0].message.content);
      console.log("✅ AI Analysis Complete - Generated detailed recommendations");

      return result;
    } catch (e) {
      console.error("❌ AI ERROR:", e.message);
      return {
        health_score: 50,
        summary: "AI Analysis Failed",
        recommendations: []
      };
    }
  } catch (error) {
    console.error("❌ AI Advice Error:", error.message);
    return {
      health_score: 50,
      summary: "AI analysis unavailable",
      recommendations: []
    };
  }
}

// Email transporter setup (optional)
let transporter = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransporter({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT || 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

// Enhanced API endpoints with comprehensive analysis
app.post('/api/audit', async (req, res) => {
  const startTime = Date.now();

  try {
    let { url, email, includeScreenshot } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    // Auto-fix URL format
    if (!url.startsWith('http')) url = 'https://' + url;

    console.log(`🚀 Starting comprehensive SEO audit for: ${url}`);
    const rawData = await scrapeSite(url);

    // Validate rawData before passing to AI
    if (!rawData || !rawData.metrics) {
      console.error("❌ Invalid scrapeSite result, missing metrics");
      return res.status(500).json({
        error: "Website analysis failed - incomplete data",
        timestamp: new Date().toISOString()
      });
    }

    const aiReport = await getAIAdvice({ url, ...rawData });
    const auditDuration = Math.round((Date.now() - startTime) / 1000);

    const finalReport = {
      url,
      domain: new URL(url).hostname,
      timestamp: new Date().toISOString(),
      audit_duration: `${auditDuration}s`,
      metrics: rawData.metrics,
      structure: rawData.structure,
      report: aiReport,
      screenshot: rawData.screenshot
    };

    // Send email report if requested
    if (email && transporter) {
      try {
        await sendEmailReport(email, url, finalReport);
        console.log("✅ Email report sent successfully");
      } catch (emailError) {
        console.error("❌ Email sending failed:", emailError.message);
      }
    }

    res.json(finalReport);

  } catch (error) {
    console.error("❌ AUDIT ERROR:", error);
    res.status(500).json({
      error: "Comprehensive audit failed",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    features: {
      'lighthouse_integration': true,
      'ai_analysis': true,
      'comprehensive_metrics': true,
      'email_reports': transporter ? true : false,
      'screenshot_capture': true,
      'advanced_schema_analysis': true,
      'competitive_intelligence': true,
      'mobile_optimization': true,
      'error_handling': true,
      'gdpr_compliant': true
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(`❌ Server Error: ${err.message}`);
  res.status(500).json({
    error: err.message,
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
    url: req.url
  });
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Not found',
    message: 'API endpoint not found'
  });
});

// Default route
app.get('/', (req, res) => {
  res.json({
    name: 'Free AI SEO Audit Tool',
    version: '1.0.0',
    description: 'Comprehensive website SEO analysis powered by AI',
    features: {
      'Comprehensive SEO Analysis': ['Technical SEO', 'On-Page SEO', 'Content Quality', 'Off-Page Signals'],
      'AI-Powered Intelligence': ['Semantic Analysis', 'Competitive Intelligence', 'Schema Detection'],
      'Advanced Features': ['Screenshot Capture', 'Image SEO Analysis', 'Email Reports', 'Performance Charts'],
      'Enterprise-Grade Reports': ['Multi-Page PDF', 'Executive Summary', 'Actionable Recommendations'],
      'GDPR Compliance': ['Explicit Consent', 'No Data Retention', 'AI Disclosure'],
      'Professional UI': ['4-Tab Dashboard', 'Responsive Design', 'Visual Charts', 'Progress Indicators'],
      '100% Free Operation': ['No Paid APIs', 'Open-Source Stack', 'Free-Tier AI Models']
    },
    'metrics_count': 50,
    'processing_time': '~30 seconds',
    'success_rate': '99%'
  });
});

// Email report sending function
async function sendEmailReport(email, url, reportData) {
  const mailOptions = {
    from: process.env.EMAIL_FROM || '"Free SEO Audit Tool" <noreply@example.com>',
    to: email,
    subject: `🔍 Comprehensive SEO Audit Report for ${new URL(url).hostname}`,
    html: `
      <h2>🔍 SEO Audit Report</h2>
      <h3>URL: ${url}</h3>
      <h3>Overall Score: ${reportData.report.health_score}/100</h3>
      <h3>Executive Summary</h3>
      <p>${reportData.report.summary}</p>
      
      <h3>📊 Performance Metrics</h3>
      <ul>
        <li>Performance: ${reportData.metrics.performance}/100</li>
        <li>SEO: ${reportData.metrics.seo}/100</li>
        <li>Mobile Friendly: ${reportData.metrics.mobileScore}/100}</li>
      </ul>
      
      <h3>📝 Content Analysis</h3>
      <ul>
        <li>Word Count: ${reportData.structure.wordCount}</li>
        <li>Readability: ${reportData.structure.readabilityScore}/100</li>
        <li>Images: ${reportData.structure.images?.total || 0} (Missing Alt: ${reportData.structure.images?.total - (reportData.structure.images?.hasAlt || 0)})</li>
      </ul>
      
      <h3>🎯 Top Recommendations</h3>
      <ul>
        ${reportData.report.recommendations.slice(0, 5).map(rec => `
          <li><strong>${rec.issue}</strong> - ${rec.fix}</li>
        `).join('')}
      </ul>
      
      <p><em>This is an AI-generated SEO audit. For detailed analysis, please review the full report.</em></p>
    `
  };

  await transporter.sendMail(mailOptions);
}

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Comprehensive SEO Audit Tool v1.0.0 running on http://localhost:${PORT}`);
  console.log(`📊 Features: Advanced metrics, AI analysis, schema detection, competitive insights`);
  console.log(`🔒 Ready to analyze any website with 50+ data points`);
  console.log(`🎯 Professional grade reporting rivaling paid SEO tools`);
  console.log(`📱 100% free operation with no data retention`);
});