#!/usr/bin/env python3
"""
Rebuild riftbound_data_expert.json from the CSV source files.
This ensures all card data is complete with proper domains and image links.
"""

import csv
import json
import os
import re
import sys
import argparse
from typing import Dict, List, Any, Optional

def parse_csv_row(row: Dict[str, str]) -> Dict[str, Any]:
    """Parse a single CSV row into a card data structure."""
    name = row.get('Name', '').strip()
    if not name:
        return None
    
    # Get collector number as ID
    card_id = row.get('Collector Number', '').strip()
    if not card_id:
        return None
    
    # Get domains
    domain1 = row.get('Domain 1', '').strip().capitalize() if row.get('Domain 1') else ''
    domain2 = row.get('Domain 2', '').strip().capitalize() if row.get('Domain 2') else ''
    
    # Build domain string
    domains = []
    if domain1 and domain1.lower() not in ['', 'nan']:
        domains.append(domain1)
    if domain2 and domain2.lower() not in ['', 'nan']:
        domains.append(domain2)
    domain_str = ', '.join(domains) if domains else 'Colorless'
    
    # Get card type
    card_type = row.get('types', '').strip().lower()
    if not card_type:
        card_type = 'unit'
    
    # Get subtypes
    subtypes = []
    for i in range(1, 6):
        subtype = row.get(f'Subtype {i}', '').strip()
        if subtype and subtype.lower() not in ['', 'nan']:
            subtypes.append(subtype.lower())
    
    # Build type_line
    if subtypes:
        type_line = f"{card_type} - {', '.join(subtypes)}"
    else:
        type_line = card_type
    
    # Get supertypes (like "basic" for runes)
    supertypes = row.get('supertypes', '').strip()
    
    # Get stats
    energy = row.get('Energy', '').strip()
    might = row.get('Might', '').strip()
    power = row.get('Power', '').strip()
    
    # Parse energy
    try:
        energy_val = float(energy) if energy and energy not in ['', '-'] else None
    except ValueError:
        energy_val = None
    
    # Parse might
    try:
        might_val = float(might) if might and might not in ['', '-'] else None
    except ValueError:
        might_val = None
    
    # Parse power (can be "C", "CC", etc. or a number)
    power_val = None
    if power and power not in ['', '-']:
        if power.upper().replace('C', '') == '':
            # It's all C's - count them
            power_val = power.upper()
        else:
            try:
                power_val = float(power)
            except ValueError:
                power_val = power
    
    # Get description (rules text)
    description = row.get('Description', '').strip()
    alt_text = row.get('ALT TEXT', '').strip()
    
    # Extract keywords from description
    keywords = extract_keywords(description)
    
    # Build the card data
    card_data = {
        'id': card_id,
        'name': name,
        'rarity': row.get('Rarity', '').strip().lower(),
        'domain': domain_str,
        'type_line': type_line,
        'stats': {
            'energy': energy_val,
            'might': might_val,
            'power': power_val
        },
        'rules_text': {
            'raw': description,
            'keywords': keywords
        }
    }
    
    # Add supertypes if present
    if supertypes and supertypes.lower() not in ['', 'nan']:
        card_data['supertypes'] = supertypes.lower()
    
    # Add tags if present
    tags = row.get('Tags', '').strip()
    if tags and tags.lower() not in ['', 'nan']:
        card_data['tags'] = [t.strip() for t in tags.split(',') if t.strip()]
    
    return card_data

def extract_keywords(text: str) -> List[str]:
    """Extract keywords from card text."""
    keywords = []
    
    # Common keywords to look for (in brackets or as standalone)
    keyword_patterns = [
        r'\[([A-Za-z]+(?:\s+\d+)?)\]',  # [Keyword] or [Keyword N]
        r'^(Action|Reaction|Hidden)\b',  # Speed keywords at start
    ]
    
    # Known keywords
    known_keywords = [
        'Accelerate', 'Action', 'Reaction', 'Hidden', 'Vision', 'Legion',
        'Assault', 'Defender', 'Elusive', 'Fearsome', 'Mighty', 'Temporary',
        'Quick Attack', 'Overwhelm', 'Lifesteal', 'Barrier', 'Spellshield',
        'Regeneration', 'Tough', 'Challenger', 'Scout', 'Fury', 'Attune',
        'Deep', 'Ephemeral', 'Last Breath', 'Nexus Strike', 'Play', 'Strike',
        'Support', 'Vulnerable', 'Capture', 'Frostbite', 'Immobile', 'Recall',
        'Silence', 'Stun', 'Obliterate', 'Rally', 'Enlightened', 'Reputation',
        'Lurk', 'Predict', 'Invoke', 'Behold', 'Augment', 'Impact', 'Formidable',
        'Equipment', 'Attach', 'Hallowed', 'Evolve', 'Husk', 'Boon', 'Flow'
    ]
    
    # Find bracketed keywords
    bracket_matches = re.findall(r'\[([^\]]+)\]', text)
    for match in bracket_matches:
        # Clean up the match
        kw = match.strip()
        # Remove numbers for keywords like "Assault 2"
        base_kw = re.sub(r'\s+\d+$', '', kw)
        if base_kw and base_kw not in keywords:
            keywords.append(kw)
    
    # Check for known keywords in text
    text_lower = text.lower()
    for kw in known_keywords:
        if kw.lower() in text_lower and kw not in keywords:
            # Check if it's actually a keyword usage (not just mentioned)
            pattern = rf'\[{re.escape(kw)}(?:\s+\d+)?\]|\({re.escape(kw)}'
            if re.search(pattern, text, re.IGNORECASE):
                if kw not in keywords:
                    keywords.append(kw)
    
    return keywords

def load_images(image_csv_path: str) -> Dict[str, str]:
    """Load image URLs from the images CSV."""
    images = {}
    with open(image_csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get('Name', '').strip()
            image_url = row.get('Card Image URL', '').strip()
            if name and image_url:
                # Make the URL absolute
                if image_url.startswith('/'):
                    image_url = f"https://riftdecks.com{image_url}"
                images[name] = image_url
    return images

def convert_legacy_to_expert(legacy_card: Dict[str, Any]) -> Dict[str, Any]:
    """Convert a legacy card format to expert format."""
    card_type = legacy_card.get('type', 'unit').lower()
    tags = legacy_card.get('tags', [])
    
    # Build type_line
    if tags:
        type_line = f"{card_type} - {', '.join(t.lower() for t in tags)}"
    else:
        type_line = card_type
    
    # Get ability info
    ability = legacy_card.get('ability', {})
    raw_text = ability.get('raw_text', '') or ability.get('effect_text', '')
    keywords = ability.get('keywords', [])
    
    return {
        'id': legacy_card.get('id', ''),
        'name': legacy_card.get('name', ''),
        'rarity': legacy_card.get('rarity', '').lower(),
        'domain': legacy_card.get('domain', 'Colorless'),
        'type_line': type_line,
        'stats': {
            'energy': legacy_card.get('cost'),
            'might': legacy_card.get('stats', {}).get('might'),
            'power': legacy_card.get('stats', {}).get('power')
        },
        'rules_text': {
            'raw': raw_text,
            'keywords': keywords
        },
        'image_url': legacy_card.get('image_url', '')
    }

def main():
    parser = argparse.ArgumentParser(description="Rebuild riftbound_data_expert (1).json from CSV sources.")
    parser.add_argument("--csv", dest="csv_path", help="Path to card data CSV")
    parser.add_argument("--images-csv", dest="images_csv_path", help="Path to image mapping CSV")
    parser.add_argument("--legacy-json", dest="legacy_path", help="Path to legacy JSON fallback data")
    parser.add_argument("--output", dest="output_path", help="Output JSON path")
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    csv_path = args.csv_path or os.path.join(base_dir, 'RiftboundCardData  - All Current Card Data (1).csv')
    images_csv_path = args.images_csv_path or os.path.join(base_dir, 'RiftboundCardData_Images.csv')
    legacy_path = args.legacy_path or os.path.join(base_dir, 'riftbound_card_data.json')
    output_path = args.output_path or os.path.join(base_dir, 'riftbound_data_expert (1).json')
    
    # Load images
    print("Loading image URLs...")
    images = load_images(images_csv_path)
    # Manual image fallbacks (if not present in images CSV)
    manual_images = {
        "Seal of Rage": "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/fbdd14adb40b0ca46b89f476a356fa21413d812e-744x1039.png",
        "Seal of Focus": "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/288c300c4e4cb10ecfe6c3cbb543d0636b306852-744x1039.png",
        "Seal of Insight": "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/9ee0dc0221f83d569e0f458374e40f7238f306c2-744x1039.png",
        "Seal of Strength": "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/415644b2798348e3d7198ec900cc40aaa4eb8bdf-744x1039.png",
        "Seal of Discord": "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/dd8433e77e46ca77aaf0be35d1774218d9a2f037-744x1039.png",
        "Seal of Unity": "https://cmsassets.rgpub.io/sanity/images/dsfx7636/game_data_live/e6fbd41d69bc0d235ea7993d2e9fa74e75e17dff-744x1039.png",
        "Vayne, Hunter": "https://riftdecks.com/img/cards/riftbound/OGN/ogn-035-298_full.png",
        "Ahri, Inquisitive": "https://riftdecks.com/img/cards/riftbound/OGN/ogn-119-298_full.png",
        "Teemo, Strategist": "https://riftdecks.com/img/cards/riftbound/OGN/ogn-121-298_full.png",
        "Sett, Brawler": "https://riftdecks.com/img/cards/riftbound/OGN/ogn-164a-298_full.png",
        "Yasuo, Windrider": "https://riftdecks.com/img/cards/riftbound/OGN/ogn-205-298_full.png",
        "Darius, Executioner": "https://riftdecks.com/img/cards/riftbound/OGN/ogn-243-298_full.png",
    }
    for name, url in manual_images.items():
        images.setdefault(name, url)
    print(f"Loaded {len(images)} image URLs")
    
    # Load legacy cards for fallback
    print("Loading legacy card data...")
    legacy_cards = []
    try:
        with open(legacy_path, 'r', encoding='utf-8') as f:
            legacy_cards = json.load(f)
        print(f"Loaded {len(legacy_cards)} legacy cards")
    except Exception as e:
        print(f"Warning: Could not load legacy cards: {e}")
    
    # Parse card data from CSV
    print("Parsing card data from CSV...")
    cards = []
    card_names_in_csv = set()
    
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            card = parse_csv_row(row)
            if card:
                # Add image URL if available
                if card['name'] in images:
                    card['image_url'] = images[card['name']]
                cards.append(card)
                card_names_in_csv.add(card['name'].lower())
    
    print(f"Parsed {len(cards)} cards from CSV")
    
    # Add legacy cards that are missing from CSV
    missing_from_csv = []
    for legacy_card in legacy_cards:
        legacy_name = legacy_card.get('name', '').lower()
        if legacy_name and legacy_name not in card_names_in_csv:
            converted = convert_legacy_to_expert(legacy_card)
            cards.append(converted)
            missing_from_csv.append(legacy_card.get('name', 'Unknown'))
    
    if missing_from_csv:
        print(f"Added {len(missing_from_csv)} cards from legacy data:")
        for name in missing_from_csv:
            print(f"  - {name}")
    
    print(f"Total cards: {len(cards)}")
    
    # Write output
    print(f"Writing to {output_path}...")
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(cards, f, indent=2, ensure_ascii=False)
    
    print("Done!")
    
    # Print some stats
    domains = {}
    types = {}
    for card in cards:
        d = card.get('domain', 'Unknown')
        t = card.get('type_line', '').split(' - ')[0]
        domains[d] = domains.get(d, 0) + 1
        types[t] = types.get(t, 0) + 1
    
    print("\nDomain distribution:")
    for d, count in sorted(domains.items()):
        print(f"  {d}: {count}")
    
    print("\nType distribution:")
    for t, count in sorted(types.items()):
        print(f"  {t}: {count}")

if __name__ == '__main__':
    main()
