import { chromium } from 'playwright'
import { z } from 'zod'
import { Anthropic } from '@anthropic-ai/sdk'
import fs from 'fs/promises'
import path from 'path'
import dotenv from 'dotenv'

// Load environment variables
dotenv.config()

// Validate required environment variables
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY is required in .env file')
}

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Schema for manufacturer data from JSON
const manufacturerSchema = z.array(z.object({
  id: z.string().uuid(),
  name: z.string(),
  websiteUrl: z.string().url(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  parentId: z.string().uuid().nullable(),
  logoFileId: z.string().uuid().optional()
}));

// Schema for component types
const componentTypeSchema = z.array(z.object({
  typeId: z.string().uuid(),
  name: z.string(),
  description: z.string().optional()
}));

// Schema for scraped component data
const componentDataSchema = z.object({
  manufacturerId: z.string().uuid(),
  typeId: z.string().uuid(),
  name: z.string(),
  modelNumber: z.string(),
  description: z.string(),
  specifications: z.object({
    dimensions: z.string().optional(),
    weight: z.string().optional(),
    capacity: z.string().optional(),
    powerRequirements: z.string().optional(),
    operatingConditions: z.string().optional()
  }).optional(),
  features: z.array(z.string()),
  urls: z.array(z.string().url())
});

async function loadManufacturers() {
  try {
    const data = await fs.readFile('Manufacturer.json', 'utf-8')
    return manufacturerSchema.parse(JSON.parse(data))
  } catch (error) {
    console.error('Error loading manufacturers:', error)
    throw error
  }
}

async function loadComponentTypes() {
  try {
    const data = await fs.readFile('component_types.json', 'utf-8')
    return componentTypeSchema.parse(JSON.parse(data))
  } catch (error) {
    console.error('Error loading component types:', error)
    throw error
  }
}

async function scrapeManufacturerProducts(manufacturer, browser, componentTypes) {
  console.log(`Processing manufacturer: ${manufacturer.name}`)
  const components = []
  const context = await browser.newContext()
  
  try {
    const page = await context.newPage()
    await page.goto(manufacturer.websiteUrl, { timeout: 30000 })
    
    // Use Claude to analyze the page and identify product listings
    const response = await anthropic.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `
          Analyze this manufacturer's website and identify HVAC components.
          For each component found, extract:
          1. Product name and model number
          2. Component type (match against: ${componentTypes.map(t => t.name).join(', ')})
          3. Technical specifications
          4. Key features
          5. Product description
          6. Direct URL to the product page
          
          Format the response as valid JSON with an array of components.
        `
      }]
    });

    const scrapedData = JSON.parse(response.content[0].text);
    
    // Process each identified component
    for (const item of scrapedData.components) {
      // Find matching component type
      const componentType = componentTypes.find(t => 
        t.name.toLowerCase() === item.type.toLowerCase()
      );
      
      if (componentType) {
        const componentData = {
          manufacturerId: manufacturer.id,
          typeId: componentType.typeId,
          name: item.name,
          modelNumber: item.modelNumber,
          description: item.description,
          specifications: item.specifications,
          features: item.features,
          urls: [item.url]
        };
        
        components.push(componentDataSchema.parse(componentData));
      }
    }
    
  } catch (error) {
    console.error(`Error processing ${manufacturer.name}:`, error)
  } finally {
    await context.close()
  }
  
  return components
}

async function ensureOutputDirectory() {
  const outputDir = './component_output'
  try {
    await fs.mkdir(outputDir, { recursive: true })
  } catch (error) {
    console.error('Error creating output directory:', error)
    throw error
  }
  return outputDir
}

async function main() {
  let browser
  
  try {
    // Ensure output directory exists
    const outputDir = await ensureOutputDirectory()
    
    // Load manufacturers and component types
    const manufacturers = await loadManufacturers()
    const componentTypes = await loadComponentTypes()
    
    // Launch browser
    browser = await chromium.launch({
      headless: true,
      timeout: 30000
    })
    
    // Process each manufacturer
    for (const manufacturer of manufacturers) {
      const components = await scrapeManufacturerProducts(
        manufacturer, 
        browser, 
        componentTypes
      )
      
      // Save results for this manufacturer
      if (components.length > 0) {
        const outputPath = path.join(
          outputDir, 
          `${manufacturer.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_components.json`
        )
        
        await fs.writeFile(
          outputPath,
          JSON.stringify(components, null, 2)
        )
        
        console.log(`Saved ${components.length} components for ${manufacturer.name}`)
      }
    }
    
  } catch (error) {
    console.error('Fatal error:', error)
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}

// Add error handler for unhandled rejections
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error)
  process.exit(1)
})

// Export functions for testing
export {
  loadManufacturers,
  loadComponentTypes,
  scrapeManufacturerProducts
}

// Run the scraper if this is the main module
if (require.main === module) {
  main()
}