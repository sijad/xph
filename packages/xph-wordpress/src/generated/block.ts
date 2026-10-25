/**
 * Generated from https://schemas.wp.org/trunk/block.json.
 * Source snapshot: packages/xph-wordpress/schemas/block.json.
 * Block API v3 snapshot. Update types and the schema snapshot together.
 */
export interface BlockJson {
	$schema?: string;
	/**
	 * The version of the Block API used by the block. If the block is registered with API version 2 or lower, the post editor may work as a non-iframe editor. Since all editors are planned to work as iframes in the future, it is recommended to set the `apiVersion` field to 3 and test the block inside the iframe editor.
	 *
	 * See the API versions documentation at https://developer.wordpress.org/block-editor/reference-guides/block-api/block-api-versions/block-migration-for-iframe-editor-compatibility/ for more details.
	 */
	apiVersion: 3;
	/**
	 * The name for a block is a unique string that identifies a block. Names have to be structured as `namespace/block-name`, where namespace is the name of your plugin or theme.
	 */
	name: string;
	/**
	 * The name of the experiment this block is a part of, or boolean true if there is no specific experiment name.
	 */
	__experimental?: string | boolean;
	/**
	 * This is the display title for your block, which can be translated with our translation functions. The block inserter will show this name.
	 */
	title: string;
	/**
	 * Blocks are grouped into categories to help users browse and discover them.
	 *  Core provided categories are: text, media, design, widgets, theme, embed
	 *
	 * Plugins and Themes can also register custom block categories.
	 *
	 * https://developer.wordpress.org/block-editor/reference-guides/filters/block-filters/#managing-block-categories
	 */
	category?: string | ('text' | 'media' | 'design' | 'widgets' | 'theme' | 'embed');
	/**
	 * Setting parent lets a block require that it is only available when nested within the specified blocks. For example, you might want to allow an ‘Add to Cart’ block to only be available within a ‘Product’ block.
	 */
	parent?: string[];
	/**
	 * The `ancestor` property makes a block available inside the specified block types at any position of the ancestor block subtree. That allows, for example, to place a ‘Comment Content’ block inside a ‘Column’ block, as long as ‘Column’ is somewhere within a ‘Comment Template’ block.
	 */
	ancestor?: string[];
	/**
	 * The `allowedBlocks` property specifies that only the listed block types can be the children of this block. For example, a ‘List’ block allows only ‘List Item’ blocks as direct children.
	 */
	allowedBlocks?: string[];
	/**
	 * An icon property should be specified to make it easier to identify a block. These can be any of WordPress’ Dashicons (slug serving also as a fallback in non-js contexts).
	 */
	icon?: string;
	/**
	 * This is a short description for your block, which can be translated with our translation functions. This will be shown in the block inspector.
	 */
	description?: string;
	/**
	 * Sometimes a block could have aliases that help users discover it while searching. For example, an image block could also want to be discovered by photo. You can do so by providing an array of unlimited terms (which are translated).
	 */
	keywords?: string[];
	/**
	 * The current version number of the block, such as 1.0 or 1.0.3. It’s similar to how plugins are versioned. This field might be used with block assets to control cache invalidation, and when the block author omits it, then the installed version of WordPress is used instead.
	 */
	version?: string;
	/**
	 * The gettext text domain of the plugin/block. More information can be found in the Text Domain section of the How to Internationalize your Plugin page.
	 *
	 * https://developer.wordpress.org/plugins/internationalization/how-to-internationalize-your-plugin/
	 */
	textdomain?: string;
	/**
	 * Attributes provide the structured data needs of a block. They can exist in different forms when they are serialized, but they are declared together under a common interface.
	 *
	 * See the attributes documentation at https://developer.wordpress.org/block-editor/reference-guides/block-api/block-attributes/ for more details.
	 */
	attributes?: {
		/**
		 * This interface was referenced by `undefined`'s JSON-Schema definition
		 * via the `patternProperty` "[a-zA-Z]".
		 */
		[k: string]:
			| {
					[k: string]: unknown | undefined;
			  }
			| undefined;
	};
	/**
	 * Context provided for available access by descendants of blocks of this type, in the form of an object which maps a context name to one of the block’s own attribute.
	 *
	 * See the block context documentation at https://developer.wordpress.org/block-editor/reference-guides/block-api/block-context/ for more details.
	 */
	providesContext?: {
		/**
		 * This interface was referenced by `undefined`'s JSON-Schema definition
		 * via the `patternProperty` "[a-zA-Z]".
		 */
		[k: string]: string | undefined;
	};
	/**
	 * Array of the names of context values to inherit from an ancestor provider.
	 *
	 * See the block context documentation at https://developer.wordpress.org/block-editor/reference-guides/block-api/block-context/ for more details.
	 */
	usesContext?: string[];
	/**
	 * It contains as set of options to control features used in the editor. See the supports documentation at https://developer.wordpress.org/block-editor/reference-guides/block-api/block-supports/ for more details.
	 */
	supports?: {
		/**
		 * Anchors let you link directly to a specific block on a page. This property adds a field to define an id for the block and a button to copy the direct link.
		 *
		 * @default false
		 */
		anchor?: boolean;
		/**
		 * Allows PHP-only blocks with a `render_callback` to appear in the block editor without JavaScript registration. The editor renders them with `ServerSideRender`. If a block uses an API version older than 3, or does not specify one, the editor uses version 3.
		 *
		 * @default false
		 */
		autoRegister?: boolean;
		/**
		 * This property adds block controls which allow to change block’s alignment.
		 */
		align?: boolean | ('wide' | 'full' | 'left' | 'center' | 'right')[];
		/**
		 * This property allows to enable wide alignment for your theme. To disable this behavior for a single block, set this flag to false.
		 *
		 * @default true
		 */
		alignWide?: boolean;
		/**
		 * This property adds UI controls which enable the user to select allowed child blocks for a block container. Note: To use this feature, pass `attributes.allowedBlocks` as the `allowedBlocks` property in the options object of `useInnerBlocksProps`.
		 *
		 * @default false
		 */
		allowedBlocks?: boolean;
		/**
		 * ARIA-labels let you define an accessible label for elements. This property allows enabling the definition of an aria-label for the block, without exposing a UI field.
		 */
		ariaLabel?:
			| boolean
			| {
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * By default, the class .wp-block-your-block-name is added to the root element of your saved markup. This helps having a consistent mechanism for styling blocks that themes and plugins can rely on. If, for whatever reason, a class is not desired on the markup, this functionality can be disabled.
		 *
		 * @default true
		 */
		className?: boolean;
		/**
		 * This value signals that a block supports some of the properties related to color. When it does, the block editor will show UI controls for the user to set their values.
		 *
		 * Note that the background and text keys have a default value of true, so if the color property is present they’ll also be considered enabled
		 */
		color?: {
			/**
			 * This property adds UI controls which allow the user to apply a solid background color to a block.
			 *
			 * When color support is declared, this property is enabled by default (along with text), so simply setting color will enable background color.
			 *
			 * To disable background support while keeping other color supports enabled, set to false.
			 *
			 * When the block declares support for color.background, its attributes definition is extended to include two new attributes: backgroundColor and style
			 *
			 * @default true
			 */
			background?: boolean;
			/**
			 * This property adds UI controls which allow the user to apply a gradient background to a block.
			 *
			 * Gradient presets are sourced from editor-gradient-presets theme support.
			 *
			 * When the block declares support for color.gradient, its attributes definition is extended to include two new attributes: gradient and style
			 *
			 * @default false
			 */
			gradients?: boolean;
			/**
			 * This property adds block controls which allow the user to set link color in a block, link color is disabled by default.
			 *
			 * Link color presets are sourced from the editor-color-palette theme support.
			 *
			 * When the block declares support for color.link, its attributes definition is extended to include the style attribute
			 *
			 * @default false
			 */
			link?: boolean;
			/**
			 * This property adds block controls which allow the user to set text color in a block.
			 *
			 * When color support is declared, this property is enabled by default (along with background), so simply setting color will enable text color.
			 *
			 * Text color presets are sourced from the editor-color-palette theme support.
			 *
			 * When the block declares support for color.text, its attributes definition is extended to include two new attributes: textColor and style
			 *
			 * @default true
			 */
			text?: boolean;
			/**
			 * This property adds block controls which allow the user to set heading colors in a block. Heading color is disabled by default.
			 *
			 * Heading color presets are sourced from the editor-color-palette theme support.
			 *
			 * When the block declares support for color.heading, its attributes definition is extended to include the style attribute
			 *
			 * @default false
			 */
			heading?: boolean;
			/**
			 * This property adds block controls which allow the user to set button colors in a block. Button color is disabled by default.
			 *
			 * Button color presets are sourced from the editor-color-palette theme support.
			 *
			 * When the block declares support for color.button, its attributes definition is extended to include the style attribute
			 *
			 * @default false
			 */
			button?: boolean;
			/**
			 * Determines whether the contrast checker widget displays in the block editor UI.
			 *
			 * The contrast checker appears only if the block declares support for color. It tests the readability of color combinations and warns if there is a potential issue. The property is enabled by default.
			 *
			 * Set to `false` to explicitly disable.
			 *
			 * @default true
			 */
			enableContrastChecker?: boolean;
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * This property adds a field to define a custom className for the block's wrapper.
		 *
		 * @default true
		 */
		customClassName?: boolean;
		/**
		 * This property adds a field to define custom CSS for the block instance.
		 *
		 * @default true
		 */
		customCSS?: boolean;
		/**
		 * This value signals that a block supports some of the CSS style properties related to dimensions. When it does, the block editor will show UI controls for the user to set their values if the theme declares support.
		 *
		 * When the block declares support for a specific dimensions property, its attributes definition is extended to include the style attribute.
		 */
		dimensions?: {
			/**
			 * Allow blocks to define an aspect ratio value.
			 *
			 * @default false
			 */
			aspectRatio?: boolean;
			/**
			 * Allow blocks to define a height value.
			 *
			 * @default false
			 */
			height?: boolean;
			/**
			 * Allow blocks to define a minimum height value.
			 *
			 * @default false
			 */
			minHeight?: boolean;
			/**
			 * Allow blocks to define a minimum width value.
			 *
			 * @default false
			 */
			minWidth?: boolean;
			/**
			 * Allow blocks to define a width value.
			 *
			 * @default false
			 */
			width?: boolean;
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * This value signals that a block supports some of the properties related to filters. When it does, the block editor will show UI controls for the user to set their values if the theme declares support.
		 *
		 * When the block declares support for a specific filter property, its attributes definition is extended to include the style attribute.
		 */
		filter?: {
			/**
			 * Allow blocks to define a duotone filter.
			 *
			 * @default false
			 */
			duotone?: boolean;
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * This value signals that a block supports some of the CSS style properties related to background. When it does, the block editor will show UI controls for the user to set their values if the theme declares support.
		 *
		 * When the block declares support for a specific background property, its attributes definition is extended to include the style attribute.
		 */
		background?: {
			/**
			 * Allow blocks to define the box a background is painted into, including clipping it to the text.
			 *
			 * @default false
			 */
			backgroundClip?: boolean;
			/**
			 * Allow blocks to define a background image.
			 *
			 * @default false
			 */
			backgroundImage?: boolean;
			/**
			 * Allow blocks to define values related to the size of a background image, including size, position, and repeat controls
			 *
			 * @default false
			 */
			backgroundSize?: boolean;
			/**
			 * Allow blocks to define gradient values.
			 *
			 * @default false
			 */
			gradient?: boolean;
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * By default, a block’s markup can be edited individually. To disable this behavior, set html to false.
		 *
		 * @default true
		 */
		html?: boolean;
		/**
		 * By default, all blocks will appear in the inserter, block transforms menu, Style Book, etc. To hide a block from all parts of the user interface so that it can only be inserted programmatically, set inserter to false.
		 *
		 * @default true
		 */
		inserter?: boolean;
		/**
		 * By default, a block can be renamed by a user from the block 'Options' dropdown or the 'Advanced' panel. To disable this behavior, set renaming to false.
		 *
		 * @default true
		 */
		renaming?: boolean;
		/**
		 * By default, a block can be hidden by a user from the block 'Options' dropdown. To disable this behavior, set visibility to false.
		 *
		 * @default true
		 */
		visibility?: boolean;
		/**
		 * This value only applies to blocks that are containers for inner blocks. If set to `true` the layout type will be `flow`. For other layout types it's necessary to set the `type` explicitly inside the `default` object.
		 */
		layout?:
			| boolean
			| {
					/**
					 * Allows setting the `type` property to define what layout type is default for the block, and also default values for any properties inherent to that layout type, e.g., for a `flex` layout, a default value can be set for `flexWrap`.
					 */
					default?: {
						/**
						 * The layout type.
						 */
						type?: 'constrained' | 'grid' | 'flex';
						/**
						 * The content size used on all children.
						 */
						contentSize?: string;
						/**
						 * The wide size used on alignwide children.
						 */
						wideSize?: string;
						/**
						 * Content justification value.
						 */
						justifyContent?: 'right' | 'center' | 'space-between' | 'left' | 'stretch';
						/**
						 * The orientation of the layout.
						 */
						orientation?: 'horizontal' | 'vertical';
						/**
						 * The flex wrap value.
						 */
						flexWrap?: 'wrap' | 'nowrap';
						/**
						 * The vertical alignment value.
						 */
						verticalAlignment?: 'top' | 'center' | 'bottom' | 'space-between' | 'stretch';
						/**
						 * The minimum column width value.
						 */
						minimumColumnWidth?: string;
						/**
						 * The column count value.
						 */
						columnCount?: number;
						/**
						 * Whether grid columns stretch to fill the available space (auto-fit) instead of leaving empty tracks (auto-fill).
						 *
						 * @default false
						 */
						autoFit?: boolean;
						[k: string]: (unknown | undefined) | undefined;
					};
					/**
					 * Exposes a switcher control that allows toggling between all existing layout types.
					 *
					 * @default false
					 */
					allowSwitching?: boolean;
					/**
					 * Determines display of layout controls in the block sidebar. If set to false, layout controls will be hidden.
					 *
					 * @default true
					 */
					allowEditing?: boolean;
					/**
					 * For the `flow` layout type only, determines display of the `Inner blocks use content width` toggle.
					 *
					 * @default true
					 */
					allowInheriting?: boolean;
					/**
					 * For the `flex` layout type only, determines display of sizing controls (Fit/Grow/Max/Fixed) on all child blocks of the flex block.
					 *
					 * @default false
					 */
					allowSizingOnChildren?: boolean;
					/**
					 * For the `flex` layout type only, determines display of vertical alignment controls in the block toolbar.
					 *
					 * @default true
					 */
					allowVerticalAlignment?: boolean;
					/**
					 * For the `flex` layout type, determines display of justification controls in the block toolbar and block sidebar. For the `constrained` layout type, determines display of justification control in the block sidebar.
					 *
					 * @default true
					 */
					allowJustification?: boolean;
					/**
					 * For the `flex` layout type only, determines display of the orientation control in the block toolbar.
					 *
					 * @default true
					 */
					allowOrientation?: boolean;
					/**
					 * For the `flex` layout type only, determines display of the wrap toggle in the block sidebar.
					 *
					 * @default true
					 */
					allowWrap?: boolean;
					/**
					 * For the `constrained` layout type only, determines display of the custom content and wide size controls in the block sidebar.
					 *
					 * @default true
					 */
					allowCustomContentAndWideSize?: boolean;
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * A non-multiple block can be inserted into each post, one time only. For example, the built-in ‘More’ block cannot be inserted again if it already exists in the post being edited. A non-multiple block’s icon is automatically dimmed (unclickable) to prevent multiple instances.
		 *
		 * @default true
		 */
		multiple?: boolean;
		/**
		 * A block may want to disable the ability of being converted into a reusable block. By default all blocks can be converted to a reusable block. If supports reusable is set to false, the option to convert the block into a reusable block will not appear.
		 *
		 * @default true
		 */
		reusable?: boolean;
		/**
		 * A block may want to disable the ability to toggle the lock state. It can be locked/unlocked by a user from the block 'Options' dropdown by default. To disable this behavior, set lock to false.
		 *
		 * @default true
		 */
		lock?: boolean;
		/**
		 * This value signals that a block supports some of the CSS style properties related to position. When it does, the block editor will show UI controls for the user to set their values if the theme declares support.
		 *
		 * When the block declares support for a specific position property, its attributes definition is extended to include the style attribute.
		 */
		position?: {
			/**
			 * Allow blocks to stick to their immediate parent when scrolling the page.
			 *
			 * @default false
			 */
			sticky?: boolean;
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * This value signals that a block supports some of the CSS style properties related to spacing. When it does, the block editor will show UI controls for the user to set their values if the theme declares support.
		 *
		 * When the block declares support for a specific spacing property, its attributes definition is extended to include the style attribute.
		 */
		spacing?: {
			margin?: boolean | ('top' | 'right' | 'left' | 'bottom')[] | ('vertical' | 'horizontal')[];
			padding?: boolean | ('top' | 'right' | 'left' | 'bottom')[] | ('vertical' | 'horizontal')[];
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * Allow blocks to define a box shadow.
		 */
		shadow?:
			| boolean
			| {
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * This value signals that a block supports some of the CSS style properties related to typography. When it does, the block editor will show UI controls for the user to set their values if the theme declares support.
		 *
		 * When the block declares support for a specific typography property, its attributes definition is extended to include the style attribute.
		 */
		typography?: {
			/**
			 * This value signals that a block supports the font-size CSS style property. When it does, the block editor will show an UI control for the user to set its value.
			 *
			 * The values shown in this control are the ones declared by the theme via the editor-font-sizes theme support, or the default ones if none is provided.
			 *
			 * When the block declares support for fontSize, its attributes definition is extended to include two new attributes: fontSize and style
			 *
			 * @default false
			 */
			fontSize?: boolean;
			/**
			 * This value signals that a block supports the line-height CSS style property. When it does, the block editor will show an UI control for the user to set its value if the theme declares support.
			 *
			 * When the block declares support for lineHeight, its attributes definition is extended to include a new attribute style of object type with no default assigned. It stores the custom value set by the user. The block can apply a default style by specifying its own style attribute with a default
			 *
			 * @default false
			 */
			lineHeight?: boolean;
			/**
			 * This property adds block toolbar controls which allow to change block's text alignment.
			 */
			textAlign?: boolean | ('left' | 'center' | 'right')[];
			/**
			 * Enable fit text support for the block. This allows text content to automatically adjust its font size to fit within the block's dimensions.
			 *
			 * @default false
			 */
			fitText?: boolean;
			/**
			 * This value signals that a block supports the text-indent CSS style property. When it does, the block editor will show a UI control for the user to set its value if the theme declares support.
			 *
			 * When the block declares support for textIndent, its attributes definition is extended to include the style attribute.
			 *
			 * @default false
			 */
			textIndent?: boolean;
			/**
			 * This value signals that a block supports the text-shadow CSS style property. When it does, the block editor will show a UI control for the user to set its value if the theme declares support.
			 *
			 * When the block declares support for textShadow, its attributes definition is extended to include the style attribute.
			 *
			 * @default false
			 */
			textShadow?: boolean;
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * Indicates if the block is using Interactivity API features.
		 */
		interactivity?:
			| boolean
			| {
					/**
					 * Indicates whether a block is compatible with the Interactivity API client-side navigation.
					 *
					 * Set it to true only if the block is not interactive or if it is interactive using the Interactivity API. Set it to false if the block is interactive but uses vanilla JS, jQuery or another JS framework/library other than the Interactivity API.
					 *
					 * @default false
					 */
					clientNavigation?: boolean;
					/**
					 * Indicates whether the block is using the Interactivity API directives.
					 *
					 * @default false
					 */
					interactive?: boolean;
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * This property marks the block itself as content. It is intended primarily for blocks that do not declare content attributes, or whose content is expressed only through their inner blocks. When enabled, content-only editing modes can still edit these blocks and allow inner blocks to be added or removed.
		 *
		 * @default false
		 */
		contentRole?: boolean;
		/**
		 * This property enables a dedicated List View panel in the block inspector for the block. When enabled, the inspector shows a List View tree for the block's inner blocks, allowing users to inspect, reorder, and manage the block's items from the sidebar instead of only using the global document List View.
		 *
		 * @default false
		 */
		listView?: boolean;
		/**
		 * This property indicates whether the block can split when the Enter key is pressed or when blocks are pasted.
		 *
		 * @default false
		 */
		splitting?: boolean;
		[k: string]: (unknown | undefined) | undefined;
	};
	/**
	 * Provides custom CSS selectors and mappings for the block. Selectors may be set for the block itself or per-feature e.g. typography. Custom selectors per feature or sub-feature, allow different block styles to be applied to different elements within the block.
	 */
	selectors?: {
		/**
		 * The primary CSS class to apply to the block. This replaces the `.wp-block-name` class if set.
		 */
		root?: string;
		/**
		 * Custom CSS selector used to generate rules for the block's theme.json border styles.
		 */
		border?:
			| string
			| {
					root?: string;
					color?: string;
					radius?: string;
					style?: string;
					width?: string;
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * Custom CSS selector used to generate rules for the block's theme.json color styles.
		 */
		color?:
			| string
			| {
					root?: string;
					text?: string;
					background?: string;
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * Custom CSS selector used to generate rules for the block's theme.json dimensions styles.
		 */
		dimensions?:
			| string
			| {
					root?: string;
					aspectRatio?: string;
					height?: string;
					minHeight?: string;
					minWidth?: string;
					width?: string;
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * Custom CSS selector used to generate rules for the block's theme.json spacing styles.
		 */
		spacing?:
			| string
			| {
					root?: string;
					blockGap?: string;
					padding?: string;
					margin?: string;
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * Custom CSS selector used to generate rules for the block's theme.json typography styles.
		 */
		typography?:
			| string
			| {
					root?: string;
					fontFamily?: string;
					fontSize?: string;
					fontStyle?: string;
					fontWeight?: string;
					lineHeight?: string;
					letterSpacing?: string;
					textDecoration?: string;
					textIndent?: string;
					textTransform?: string;
					[k: string]: (unknown | undefined) | undefined;
			  };
		/**
		 * Custom CSS selector used when generating the block's custom CSS rules set via Global Styles.
		 */
		css?:
			| string
			| {
					root?: string;
					[k: string]: (unknown | undefined) | undefined;
			  };
		[k: string]: (unknown | undefined) | undefined;
	};
	/**
	 * Block styles can be used to provide alternative styles to block. It works by adding a class name to the block’s wrapper. Using CSS, a theme developer can target the class name for the block style if it is selected.
	 *
	 * Plugins and Themes can also register custom block style for existing blocks.
	 *
	 * https://developer.wordpress.org/block-editor/reference-guides/block-api/block-styles/
	 */
	styles?: {
		name: string;
		label: string;
		/**
		 *
		 *
		 * @default false
		 */
		isDefault?: boolean;
	}[];
	/**
	 * It provides structured example data for the block. This data is used to construct a preview for the block to be shown in the Inspector Help Panel when the user mouses over the block.
	 *
	 * See the example documentation at https://developer.wordpress.org/block-editor/reference-guides/block-api/block-registration/#example-optional for more details.
	 */
	example?: {
		/**
		 * The viewportWidth controls the width of the iFrame container in which the block preview will get rendered
		 *
		 * @default 1200
		 */
		viewportWidth?: number;
		/**
		 * Set the attributes for the block example
		 */
		attributes?: {
			[k: string]: (unknown | undefined) | undefined;
		};
		/**
		 * Set the inner blocks that should be used within the block example. The blocks should be defined as a nested array like this:
		 *
		 * [ { "name": "core/heading", "attributes": { "content": "This is an Example" } } ]
		 *
		 * Where each block itself is an object that contains the block name, the block attributes, and the blocks inner blocks.
		 */
		innerBlocks?: unknown[];
		/**
		 * Static HTML fragments interleaved with inner blocks, where null entries mark the positions of the inner blocks within the static markup. Only applies to the Custom HTML block.
		 */
		innerContent?: (string | null)[];
		[k: string]: (unknown | undefined) | undefined;
	};
	/**
	 * Block Hooks allow a block to automatically insert itself next to all instances of a given block type.
	 *
	 * See the Block Hooks documentation at https://developer.wordpress.org/block-editor/reference-guides/block-api/block-registration/#block-hooks-optional for more details.
	 */
	blockHooks?: {
		/**
		 * This interface was referenced by `undefined`'s JSON-Schema definition
		 * via the `patternProperty` "^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$".
		 */
		[k: string]: ('before' | 'after' | 'firstChild' | 'lastChild') | undefined;
	};
	/**
	 * Block type editor script definition. It will only be enqueued in the context of the editor.
	 */
	editorScript?: string | string[];
	/**
	 * Block type frontend and editor script definition. It will be enqueued both in the editor and when viewing the content on the front of the site.
	 */
	script?: string | string[];
	/**
	 * Block type frontend script definition. It will be enqueued only when viewing the content on the front of the site.
	 */
	viewScript?: string | string[];
	/**
	 * Block type frontend script module definition. It will be enqueued only when viewing the content on the front of the site.
	 */
	viewScriptModule?: string | string[];
	/**
	 * Block type editor style definition. It will only be enqueued in the context of the editor.
	 */
	editorStyle?: string | string[];
	/**
	 * Block type frontend style definition. It will be enqueued both in the editor and when viewing the content on the front of the site.
	 */
	style?: string | string[];
	/**
	 * Block type frontend style definition. It will be enqueued only when viewing the content on the front of the site.
	 */
	viewStyle?: string | string[];
	/**
	 * Block Variations is the API that allows a block to have similar versions of it, but all these versions share some common functionality.
	 */
	variations?:
		| string
		| {
				/**
				 * The unique and machine-readable name.
				 */
				name: string;
				/**
				 * A human-readable variation title.
				 */
				title: string;
				/**
				 * A detailed variation description.
				 */
				description?: string;
				/**
				 * A category classification, used in search interfaces to arrange block types by category.
				 */
				category?: string | ('text' | 'media' | 'design' | 'widgets' | 'theme' | 'embed');
				/**
				 * An icon helping to visualize the variation. It can have the same shape as the block type.
				 */
				icon?: string;
				/**
				 * Indicates whether the current variation is the default one.
				 *
				 * @default false
				 */
				isDefault?: boolean;
				/**
				 * Values that override block attributes.
				 */
				attributes?: {
					[k: string]: (unknown | undefined) | undefined;
				};
				/**
				 * Initial configuration of nested blocks.
				 */
				innerBlocks?: unknown[][];
				/**
				 * Static HTML fragments interleaved with inner blocks, where null entries mark the positions of the inner blocks within the static markup. Only applies to the Custom HTML block.
				 */
				innerContent?: (string | null)[];
				/**
				 * Example provides structured data for the block preview. You can set to undefined to disable the preview shown for the block type.
				 */
				example?: {
					[k: string]: (unknown | undefined) | undefined;
				};
				/**
				 * The list of scopes where the variation is applicable.
				 *
				 * @default ["inserter","block"]
				 */
				scope?: ('inserter' | 'block' | 'transform')[];
				/**
				 * An array of terms (which can be translated) that help users discover the variation while searching.
				 */
				keywords?: string[];
				/**
				 * The list of attributes that should be compared. Each attributes will be matched and the variation will be active if all of them are matching.
				 */
				isActive?: string[];
		  }[];
	/**
	 * Template file loaded on the server when rendering a block.
	 */
	render?: string;
}
